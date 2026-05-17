// Optional Redis backing for multi-replica relay deployments.
//
// `pane` is open-core: it self-hosts on SQLite and runs locally with zero
// external services. Redis (e.g. Azure Cache for Redis) is a paid dependency
// that the OSS core MUST NOT require. So Redis is strictly OPTIONAL:
//
//   - REDIS_URL unset  -> this module stays dormant. broadcast / rate-limit /
//                         presence use their original in-process paths and
//                         single-replica behaviour is byte-for-byte unchanged.
//   - REDIS_URL set    -> `ioredis` is dynamically imported and three
//                         connections are opened (see below). broadcast,
//                         rate-limit and presence switch to Redis-backed
//                         implementations so multiple replicas stay correct.
//
// `ioredis` lives in optionalDependencies and is imported lazily here, so a
// self-host install never pulls it. If REDIS_URL is set but the package is not
// installed, initRedis() fails fast with an actionable message.
//
// Connection model — three connections, by necessity and by design:
//   1. `pub` — issues PUBLISH and all ordinary commands (ZADD, HSET, ...).
//   2. `sub` — held in subscriber mode. An ioredis connection in subscriber
//              mode CANNOT run ordinary commands, so SUBSCRIBE needs its own
//              dedicated connection. broadcast.ts owns the channel routing.
//   3. shared with `pub` for rate-limit + presence commands (no extra conn).
//
// Error policy:
//   - Boot: if REDIS_URL is set but Redis is unreachable, initRedis() rejects
//     and the relay exits — a relay that silently lost its shared state would
//     be worse than one that refuses to start.
//   - Mid-flight: a connection blip is logged via the `error` handler and
//     ioredis auto-reconnects. We do NOT crash the process for a transient
//     Redis error; individual operations surface their own failures to their
//     callers, which degrade gracefully (see broadcast/rate-limit/presence).

import { loadConfig } from "./config.js";
import { log } from "./log.js";

// Minimal structural type for the bits of an ioredis client we use. Declared
// locally so this module type-checks without `ioredis` installed (it is an
// optionalDependency and may be absent in a self-host build).
export interface RedisLike {
  status: string;
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: "message", cb: (channel: string, message: string) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "connect" | "ready" | "close" | "end", cb: () => void): void;
  // Sorted-set + hash + key commands used by rate-limit.ts and presence.ts.
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  keys(pattern: string): Promise<string[]>;
  pexpire(key: string, ms: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  multi(): RedisMultiLike;
  quit(): Promise<unknown>;
  disconnect(): void;
  // Test-only: used by the env-gated integration suite to reset Redis between
  // assertions. Not used by production code paths.
  flushdb?(): Promise<unknown>;
}

export interface RedisMultiLike {
  zadd(key: string, score: number, member: string): RedisMultiLike;
  zremrangebyscore(key: string, min: number, max: number): RedisMultiLike;
  zcard(key: string): RedisMultiLike;
  pexpire(key: string, ms: number): RedisMultiLike;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

// ioredis' constructor, narrowed to what we need. `new (url, opts)`.
type RedisCtor = new (url: string, opts?: Record<string, unknown>) => RedisLike;

interface RedisState {
  pub: RedisLike;
  sub: RedisLike;
}

let state: RedisState | null = null;

/** True when REDIS_URL is configured — i.e. multi-replica mode is requested. */
export function redisConfigured(): boolean {
  return Boolean(loadConfig().REDIS_URL);
}

/**
 * True when Redis is configured AND the connections have been initialised.
 * broadcast / rate-limit / presence branch on this to pick their backend.
 */
export function redisEnabled(): boolean {
  return state !== null;
}

/** The PUBLISH / command connection. Throws if Redis is not initialised. */
export function redisPub(): RedisLike {
  if (!state) throw new Error("redis: not initialised (REDIS_URL unset?)");
  return state.pub;
}

/** The dedicated SUBSCRIBE connection. Throws if Redis is not initialised. */
export function redisSub(): RedisLike {
  if (!state) throw new Error("redis: not initialised (REDIS_URL unset?)");
  return state.sub;
}

/**
 * Dynamically load the optional `ioredis` package. Isolated so the
 * "set but not installed" failure has one clear, actionable message.
 */
async function loadIoredis(): Promise<RedisCtor> {
  try {
    const mod = (await import("ioredis")) as unknown as {
      default?: RedisCtor;
    } & RedisCtor;
    // ioredis is CJS; the constructor is the default export under ESM interop.
    return (mod.default ?? mod) as RedisCtor;
  } catch {
    throw new Error(
      "REDIS_URL is set but the optional `ioredis` package is not installed " +
        "— run `npm install ioredis` (it ships in optionalDependencies; a " +
        "self-host install without REDIS_URL does not need it).",
    );
  }
}

/** Open one connection and wait for it to become ready, or reject on error. */
function openConnection(
  Ctor: RedisCtor,
  url: string,
  label: string,
): Promise<RedisLike> {
  // maxRetriesPerRequest:null + a bounded retry strategy: ioredis keeps
  // reconnecting on a mid-flight blip rather than failing pending commands
  // outright, but the FIRST connect is awaited below so a boot-time failure
  // still rejects.
  const conn = new Ctor(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });

  conn.on("error", (err: Error) => {
    // Mid-flight errors are logged, not fatal — ioredis auto-reconnects.
    log.warn(`redis ${label} connection error`, { error: err.message });
  });
  conn.on("close", () => log.debug(`redis ${label} connection closed`));
  conn.on("ready", () => log.debug(`redis ${label} connection ready`));

  return new Promise<RedisLike>((resolve, reject) => {
    let settled = false;
    conn.on("ready", () => {
      if (settled) return;
      settled = true;
      resolve(conn);
    });
    // The very first connect attempt: surface failure so initRedis() rejects
    // and the relay exits rather than booting with no shared state.
    void (conn as unknown as { connect(): Promise<void> })
      .connect()
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `redis ${label} connection failed: ` +
              (err instanceof Error ? err.message : String(err)),
          ),
        );
      });
  });
}

/**
 * Initialise Redis on boot. No-op when REDIS_URL is unset. When set, loads
 * `ioredis`, opens the pub + sub connections, and fails fast (rejects) if the
 * package is missing or Redis is unreachable.
 */
export async function initRedis(): Promise<void> {
  if (!redisConfigured()) {
    log.info("redis disabled (REDIS_URL unset) — single-replica mode");
    return;
  }
  if (state) return;

  const url = loadConfig().REDIS_URL!;
  const Ctor = await loadIoredis();
  const pub = await openConnection(Ctor, url, "pub");
  let sub: RedisLike;
  try {
    sub = await openConnection(Ctor, url, "sub");
  } catch (err) {
    // pub already opened — clean it up so a half-open state doesn't linger.
    pub.disconnect();
    throw err;
  }
  state = { pub, sub };
  log.info("redis enabled — multi-replica mode", {
    url: redactRedisUrl(url),
  });
}

/** Close both Redis connections on graceful shutdown. Safe to call when off. */
export async function shutdownRedis(): Promise<void> {
  if (!state) return;
  const { pub, sub } = state;
  state = null;
  await Promise.allSettled([pub.quit(), sub.quit()]);
  log.debug("redis connections closed");
}

/** Mask any userinfo (redis://user:pass@host) before logging a Redis URL. */
function redactRedisUrl(url: string): string {
  return url.replace(/:\/\/([^@/]+)@/, "://<redacted>@");
}

// Test-only: reset module state so a test can re-init. Not part of the API.
export function _resetRedisForTests(): void {
  state = null;
}
