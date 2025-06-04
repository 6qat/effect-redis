// Enable Node.js compatibility for Buffer
import { Buffer } from 'node:buffer';

import { BunRuntime } from '@effect/platform-bun';
import { Config, Effect, Layer, Schedule, Stream, pipe } from 'effect';
import {
  RedisConnectionOptionsLive,
  RedisStream,
  RedisStreamLive,
  type StreamEntry,
} from '../src';
import type { RedisArgument } from 'redis';

/**
 * Example demonstrating Redis Stream operations:
 * 1. Writing to a stream
 * 2. Reading only new entries (from $ position)
 */
const program = Effect.gen(function* () {
  const redisStream = yield* RedisStream;
  const streamKey = 'mystream';

  // Producer: adds a new entry to the stream every 2 seconds
  const producer = Effect.gen(function* () {
    let counter = 0;

    yield* Effect.logInfo('Starting stream producer...');

    yield* pipe(
      Effect.sync(() => {
        counter++;
        return {
          timestamp: String(Date.now()),
          value: String(counter),
          message: `Message #${counter}`,
        };
      }),
      Effect.flatMap((data) =>
        pipe(
          redisStream.xadd(streamKey, '*', data),
          Effect.tap((id) => Effect.logInfo(`Added entry with ID: ${id}`)),
        ),
      ),
      Effect.repeat(Schedule.spaced('1 seconds')),
    );
  });

  // Consumer: reads only new entries from the stream using $ identifier
  const consumer = Effect.gen(function* () {
    yield* Effect.logInfo(
      'Starting stream consumer with $ identifier (only new messages)...',
    );

    let lastId: RedisArgument = '$';

    while (true) {
      const entries: StreamEntry[] = yield* redisStream.xread(
        streamKey,
        lastId,
        5000,
        100,
      );

      if (entries.length > 0) {
        lastId = entries[entries.length - 1].id;
        yield* Effect.logInfo(
          `Received ${entries.length} new entries: ${JSON.stringify(entries, null, 2)}`,
        );
      } else {
        yield* Effect.logInfo('No new entries received (timeout)');
      }

      yield* Effect.sleep('4 seconds');
    }
  });

  // Start both producer and consumer
  yield* producer.pipe(Effect.fork);
  yield* consumer.pipe(Effect.fork);

  // Keep the program running
  yield* Effect.never;
});

// Range reader example - separate function to show how to read a range of entries
const _readRangeExample = Effect.gen(function* () {
  const redisStream = yield* RedisStream;
  const streamKey = 'mystream';

  yield* Effect.logInfo('Reading all stream entries from beginning to end...');

  const entries = yield* redisStream.xrange(
    streamKey,
    '-', // Start from earliest entry
    '+', // End with latest entry
  );

  yield* Effect.logInfo(
    `Retrieved ${entries.length} entries from stream ${streamKey}`,
  );

  if (entries.length > 0) {
    yield* Effect.logInfo(`First entry ID: ${entries[0].id}`);
    yield* Effect.logInfo(`Last entry ID: ${entries[entries.length - 1].id}`);
  }

  return entries;
});

// Main entry point
BunRuntime.runMain(
  Effect.gen(function* () {
    const redisHost = yield* Config.string('REDIS_HOST');
    const redisPort = yield* Config.number('REDIS_PORT');
    const redisOptions = RedisConnectionOptionsLive({
      url: `redis://${redisHost}:${redisPort}`,
    });

    return yield* pipe(
      Effect.scoped(
        Effect.provide(program, Layer.provide(RedisStreamLive, redisOptions)),
      ),
      Effect.catchAll((error) => {
        return Effect.logError(`🚫 Recovering from error: ${error.message}`);
      }),
      Effect.catchAllCause((cause) => {
        return Effect.logError(
          `💥 Recovering from defect: ${cause.toString().split('\n')[0]}`,
        );
      }),
    );
  }),
);
