# Effect-Redis

A lightweight wrapper around the official `redis` client that integrates seamlessly with the [Effect](https://github.com/Effect-TS/effect) ecosystem.

*   Resource–safe connections (acquire / release handled for you)
*   _Layers_ for dependency-injection
*   Tagged error type (`RedisError`) with rich cause information
*   Declarative, interrupt-safe `publish` / `subscribe` / `setValue` helpers
*   Tiny surface — bring your own redis commands via the `Redis` service when you need full power

---

## Installation

```bash
pnpm add effect-redis redis @effect/data @effect/io
```

> The library itself is runtime-agnostic. Under Bun you will usually also have `@effect/platform-bun` around — that is **not** required by `effect-redis`.

---

## Quick-start

```ts
import { Effect, Layer } from "effect";
import {
  RedisConnectionOptionsLive,
  RedisPubSubLive,
  RedisPersistenceLive,
  RedisPubSub,
  RedisPersistence,
} from "effect-redis";

const redisLayer = RedisConnectionOptionsLive({
  url: "redis://localhost:6379",
}).pipe(Layer.provideMerge(RedisPubSubLive), Layer.provideMerge(RedisPersistenceLive));

const program = Effect.gen(function* () {
  /* services */
  const pubsub  = yield* RedisPubSub;
  const storage = yield* RedisPersistence;

  /* persistence */
  yield* storage.setValue("user:42", JSON.stringify({ name: "Ada" }));

  /* pub / sub */
  yield* pubsub.subscribe("notifications", (msg) => {
    console.log("🔔", msg);
  });

  yield* pubsub.publish("notifications", "Hello world!");
});

Effect.runPromise(program.pipe(Effect.provide(redisLayer)));
```

---

## Provided Layers & Services

| Layer                                    | Service                | What you get                                  |
| ---------------------------------------- | ---------------------- | --------------------------------------------- |
| `RedisConnectionOptionsLive(options?)`   | —                      | Supplies connection settings downstream       |
| `RedisLive`                              | `Redis`                | Raw access to an already connected client     |
| `RedisPubSubLive`                        | `RedisPubSub`          | `publish / subscribe` helpers                 |
| `RedisPersistenceLive`                   | `RedisPersistence`     | Simple `setValue` helper                      |

All Layers are *scoped* — the underlying connection is opened once and **closed automatically** when the scope ends.

### Error model

Every operation can fail with **`RedisError`** — a tagged error enriched with the original cause:

```ts
import { Effect } from "effect";
import { RedisPersistence, RedisError } from "effect-redis";

const safe = RedisPersistence.pipe(
  Effect.flatMap(({ setValue }) => setValue("x", "y")),
  Effect.catchTag("RedisError", (e: RedisError) => Effect.logError(e.message))
);
```

---

## Usage patterns

### 1. Pub / Sub micro-service

Extracted from the repo’s own `winfut.ts` example:

```ts
import { BunRuntime } from "@effect/platform-bun";
import { Effect, Queue, Stream, pipe } from "effect";
import { RedisConnectionOptionsLive, RedisPubSubLive, RedisPubSub } from "effect-redis";

const program = Effect.gen(function* () {
  const q   = yield* Queue.unbounded<string>();
  const rps = yield* RedisPubSub;

  /* subscribe */
  yield* rps.subscribe("raw", (msg) => Queue.unsafeOffer(q, msg));

  /* process stream */
  yield* pipe(
    Stream.fromQueue(q),
    Stream.filter((m) => m.startsWith("T:WIN")),
    Stream.tap((m) => rps.publish("winfut", m)),
    Stream.runDrain
  );
});

BunRuntime.runMain(
  Effect.provide(
    program,
    Layer.provide(RedisPubSubLive, RedisConnectionOptionsLive({ url: "redis://localhost:6379" }))
  )
);
```

### 2. Metrics aggregation

See `metrics.ts` for the full blown version, the gist is:

```ts
const metricsProg = Effect.gen(function* () {
  const rps = yield* RedisPubSub;
  yield* rps.subscribe("winfut", handleTick);
  // … aggregate & publish …
});
```

### 3. Low-level commands via `Redis`

The thin `Redis` service gives you the connected **node-redis client** when you need functions not wrapped by this lib:

```ts
import { Redis } from "effect-redis";

const incrProg = Redis.pipe(
  Effect.flatMap(({ use }) =>
    use((client) => client.incr("counter"))
  )
);
```

---

## Reference

### `RedisConnectionOptionsLive(options?) → Layer`
Creates a live Layer that exposes `RedisConnectionOptions` downstream. The `options` object is forwarded to `createClient(options)` from `redis`.

### `RedisPubSub` service
```ts
publish(channel: string, message: string): Effect<void, RedisError>
subscribe(channel: string, handler: (msg: string) => void): Effect<void, RedisError>
```

### `RedisPersistence` service
```ts
setValue(key: string, value: string): Effect<void, RedisError>
```

### `Redis` service
```ts
use<T>(fn: (client: RedisClient) => T | Promise<T>): Effect<T, RedisError>
```
Gives access to the raw `RedisClient` from `redis`. The connection is shared and stays open for the whole scope.

---

## Contributing / TODO

*   Expose more common redis commands (get, del, etc.)
*   Connection pooling?
*   Add tests against `redis-mock`

PRs welcome!
