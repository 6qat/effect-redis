import { BunRuntime } from '@effect/platform-bun';
import { Config, Effect, Layer, Queue, Stream, pipe } from 'effect';
import {
  RedisConnectionOptionsLive,
  RedisPubSub,
  RedisPubSubLive,
  RedisStream,
  RedisStreamLive,
} from '../src';

const program = Effect.gen(function* () {
  const incomingQueue = yield* Queue.unbounded<string>();
  const redisPubSub = yield* RedisPubSub;
  const redisStream = yield* RedisStream;
  // yield* redisStream.xadd('raw', '*', { message: 'test' });

  yield* redisPubSub.subscribe('raw', (message: string) => {
    Queue.unsafeOffer(incomingQueue, message);
  });
  const stream = Stream.fromQueue(incomingQueue);
  yield* pipe(
    stream,
    Stream.filter((message) => message.startsWith('T:WIN')),
    Stream.tap((message) =>
      // redisPubSub.publish('winfut', JSON.stringify(message)),
      redisStream.xadd('winfut', '*', { message }),
    ),
    Stream.runDrain,
    Effect.fork,
  );
  yield* Effect.never;
});

BunRuntime.runMain(
  Effect.gen(function* () {
    const redisHost = yield* Config.string('REDIS_HOST');
    const redisPort = yield* Config.number('REDIS_PORT');
    const redisOptions = RedisConnectionOptionsLive({
      url: `redis://${redisHost}:${redisPort}`,
    });

    const redisPubSubLayer = Layer.provide(RedisPubSubLive, redisOptions);
    const redisStreamLayer = Layer.provide(RedisStreamLive, redisOptions);

    return yield* pipe(
      Effect.scoped(
        Effect.provide(
          program,
          Layer.provideMerge(redisPubSubLayer, redisStreamLayer),
        ),
      ),
      Effect.catchAll((error) => {
        return Effect.log(`🚫 Recovering from error ${error}`);
      }),
      Effect.catchAllCause((cause) => {
        return Effect.logError(
          `💥 Recovering from defect(${cause.toString().split('\n')[0]}) ${JSON.stringify(cause.toJSON(), null, 2)}`,
        );
      }),
    );
  }),
);
