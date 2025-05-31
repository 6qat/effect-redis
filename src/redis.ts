import { Context, Data, Effect, Layer } from 'effect';
import { createClient } from 'redis';

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

export {
  RedisPersistence,
  RedisPubSub,
  RedisConnectionOptions,
  Redis,
  RedisPersistenceLive,
  RedisPubSubLive,
  RedisConnectionOptionsLive,
  RedisLive,
};
