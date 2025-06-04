import { Context, Data, Effect, Layer } from 'effect';
import { type RedisArgument, createClient } from 'redis';

export class RedisError extends Data.TaggedError('RedisError')<{
  cause: unknown;
  message: string;
}> {}

interface RedisConnectionOptionsShape {
  options?: Parameters<typeof createClient>[0];
}
class RedisConnectionOptions extends Context.Tag('RedisConnectionOptions')<
  RedisConnectionOptions,
  RedisConnectionOptionsShape
>() {}

const RedisConnectionOptionsLive = (
  options?: Parameters<typeof createClient>[0],
) =>
  Layer.succeed(
    RedisConnectionOptions,
    RedisConnectionOptions.of({
      options,
    }),
  );

interface RedisShape {
  use: <T>(
    fn: (client: ReturnType<typeof createClient>) => T,
  ) => Effect.Effect<Awaited<T>, RedisError, never>;
}
class Redis extends Context.Tag('Redis')<Redis, RedisShape>() {}

interface RedisPubSubShape {
  publish: (
    channel: string,
    message: string,
  ) => Effect.Effect<void, RedisError, never>;
  subscribe: (
    channel: string,
    handler: (message: string) => void,
  ) => Effect.Effect<void, RedisError, never>;
}

class RedisPubSub extends Context.Tag('RedisPubSub')<
  RedisPubSub,
  RedisPubSubShape
>() {}

interface RedisPersistenceShape {
  setValue: (
    key: string,
    value: string,
  ) => Effect.Effect<void, RedisError, never>;
}

class RedisPersistence extends Context.Tag('RedisPersistence')<
  RedisPersistence,
  RedisPersistenceShape
>() {}

// Stream related types
export interface StreamEntry {
  id: RedisArgument;
  message: Record<string, string>;
}

interface RedisStreamShape {
  // Add an entry to a stream
  xadd: (
    key: RedisArgument,
    id: RedisArgument | '*',
    message: Record<string, RedisArgument>,
  ) => Effect.Effect<string, RedisError, never>;

  // Read from a stream with ability to block and wait for new entries
  xread: (
    key: RedisArgument,
    id: RedisArgument, // Use '$' to read only new entries from now
    block?: number, // Block in milliseconds, 0 for indefinite
    count?: number, // Max number of entries to return
  ) => Effect.Effect<StreamEntry[], RedisError, never>;

  // Read a range of entries from a stream
  xrange: (
    key: RedisArgument,
    start: RedisArgument, // '-' for earliest available
    end: RedisArgument, // '+' for latest available
    count?: number,
  ) => Effect.Effect<StreamEntry[], RedisError, never>;
}

class RedisStream extends Context.Tag('RedisStream')<
  RedisStream,
  RedisStreamShape
>() {}

// Common code for redis client creation
const redisClientEffect = Effect.gen(function* () {
  const { options } = yield* RedisConnectionOptions;

  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createClient(options)
          .connect()
          .then((r) => {
            console.log('Connected to Redis');
            r.on('error', (e) => {
              console.log('Redis error(on error):', e.message);
              r.destroy();
            });
            r.on('end', () => {
              console.log('Connection to Redis ended');
            });
            return r;
          }),
      catch: (e) =>
        new RedisError({
          cause: e,
          message: 'Error while connecting to Redis',
        }),
    }),
    (client) =>
      Effect.sync(() => {
        if (client.isReady) {
          client.quit();
        }
      }),
  );
});

const bootstrapRedisServiceEffect = Effect.gen(function* () {
  const client = yield* redisClientEffect;
  return Redis.of({
    use: (fn) =>
      Effect.gen(function* () {
        const result = yield* Effect.try({
          try: () => fn(client),
          catch: (e) =>
            new RedisError({
              cause: e,
              message: 'Synchronous error in `Redis.use`',
            }),
        });
        if (result instanceof Promise) {
          return yield* Effect.tryPromise({
            try: () => result,
            catch: (e) =>
              new RedisError({
                cause: e,
                message: 'Asynchronous error in `Redis.use`',
              }),
          });
        }
        return result;
      }),
  });
});

const RedisLive = Layer.scoped(Redis, bootstrapRedisServiceEffect);

const bootstrapRedisPersistenceServiceEffect = Effect.gen(function* () {
  const client = yield* redisClientEffect;

  return RedisPersistence.of({
    setValue: (key, value) =>
      Effect.tryPromise({
        try: () => client.set(key, value),
        catch: (e) =>
          new RedisError({
            cause: e,
            message: 'Error in `Redis.setValue`',
          }),
      }),
  });
});

const RedisPersistenceLive = Layer.scoped(
  RedisPersistence,
  bootstrapRedisPersistenceServiceEffect,
);

const bootstrapRedisPubSubServiceEffect = Effect.gen(function* () {
  const clientPublish = yield* redisClientEffect;
  const clientSubscribe = yield* redisClientEffect;

  return RedisPubSub.of({
    publish: (channel, message) =>
      Effect.tryPromise({
        try: () => clientPublish.publish(channel, message),
        catch: (e) =>
          new RedisError({
            cause: e,
            message: 'Error in `Redis.publish`',
          }),
      }),
    subscribe: (channel, handler) =>
      Effect.tryPromise({
        try: () => clientSubscribe.subscribe(channel, handler),
        catch: (e) =>
          new RedisError({
            cause: e,
            message: 'Error in `Redis.subscribe`',
          }),
      }),
  });
});

const RedisPubSubLive = Layer.scoped(
  RedisPubSub,
  bootstrapRedisPubSubServiceEffect,
);

// Redis Stream implementation
const bootstrapRedisStreamServiceEffect = Effect.gen(function* () {
  // Separate connections: one dedicated to writes (producer) and one to reads (consumer)
  const clientProducer = yield* redisClientEffect;
  const clientConsumer = yield* redisClientEffect;

  return RedisStream.of({
    xadd: (
      key: RedisArgument,
      id: RedisArgument,
      message: Record<string, RedisArgument>,
    ) =>
      Effect.tryPromise({
        try: async () => {
          // Pass the message object directly to xAdd
          return await clientProducer.xAdd(key, id, message);
        },
        catch: (e) =>
          new RedisError({
            cause: e,
            message: 'Error in `RedisStream.xadd`',
          }),
      }),

    xread: (
      key: RedisArgument,
      id: RedisArgument,
      block?: number,
      count?: number,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const options: Record<string, number> = {};

          if (block !== undefined) {
            options.BLOCK = block;
          }

          if (count !== undefined) {
            options.COUNT = count;
          }

          // Create proper XReadStream objects instead of arrays
          const streams = [{ key, id }];
          const result = await clientConsumer.xRead(streams, options);

          if (!result) {
            return [];
          }

          // Transform result into StreamEntry[] format
          if (!Array.isArray(result)) {
            return [];
          }

          return result.flatMap((stream) => {
            // Type guard to check if stream has the expected structure
            if (
              stream &&
              typeof stream === 'object' &&
              'messages' in stream &&
              Array.isArray(stream.messages)
            ) {
              return stream.messages.map((msg) => {
                // Add type guard for msg
                if (msg && typeof msg === 'object' && 'id' in msg) {
                  return {
                    id: String(msg.id), // Convert to string explicitly
                    message: msg.message as Record<string, string>,
                  };
                }
                // Return a default or handle error case
                return {
                  id: '',
                  message: {} as Record<string, string>,
                };
              });
            }

            return [];
          });
        },
        catch: (e) =>
          new RedisError({
            cause: e,
            message: 'Error in `RedisStream.xread`',
          }),
      }),

    xrange: (
      key: RedisArgument,
      start: RedisArgument,
      end: RedisArgument,
      count?: number,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const options: Record<string, number> = {};

          if (count !== undefined) {
            options.COUNT = count;
          }

          const result = await clientConsumer.xRange(key, start, end, options);

          // Transform result into StreamEntry[] format
          return result.map((msg) => ({
            id: msg.id,
            message: msg.message as Record<string, string>,
          }));
        },
        catch: (e) =>
          new RedisError({
            cause: e,
            message: 'Error in `RedisStream.xrange`',
          }),
      }),
  });
});

const RedisStreamLive = Layer.scoped(
  RedisStream,
  bootstrapRedisStreamServiceEffect,
);

export {
  RedisPersistence,
  RedisPubSub,
  RedisConnectionOptions,
  Redis,
  RedisStream,
  RedisPersistenceLive,
  RedisPubSubLive,
  RedisConnectionOptionsLive,
  RedisLive,
  RedisStreamLive,
};
