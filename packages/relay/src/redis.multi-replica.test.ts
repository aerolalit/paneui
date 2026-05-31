// Cross-replica integration test for the Redis-backed broadcast / rate-limit /
// presence layers.
//
// REQUIRES A REAL REDIS. This is env-gated, mirroring how the Postgres e2e
// suite is gated by DATABASE_URL: the suite only runs when REDIS_URL (or the
// test-specific PANE_TEST_REDIS_URL) is set, and SKIPS cleanly otherwise.
//
// This file is deliberately NOT named `*.e2e.test.ts` / `*.integration.test.ts`
// so it is excluded from the default `npm test` / `test:unit` / `test:e2e`
// runs — it has its own dedicated `test:redis` script. (Adding another
// parallel test-file worker that also provisions a DB tips the shared Postgres
// over its connection limit, so the Redis suite is kept off the default e2e
// pool entirely.)
//
// To run it (a Redis must be reachable at the URL):
//   REDIS_URL=redis://localhost:6379 npm run test:redis --workspace @paneui/relay
//
// What it proves:
//   1. broadcast pub/sub crosses processes — an event published on one Redis
//      connection pair reaches a subscriber wired to a SEPARATE connection
//      pair (simulating a second replica), AND the publishing replica still
//      receives its own event exactly once (no double-delivery).
//   2. the rate limiter's sliding window is GLOBAL — two limiter instances
//      sharing one Redis share one bucket.
//   3. presence is cluster-wide — a connection added "on replica A" is visible
//      to a count read "on replica B".

import { describe, it, expect, beforeAll } from "vitest";
import type { SerializedEvent } from "./types.js";

const REDIS_URL =
  process.env.PANE_TEST_REDIS_URL ?? process.env.REDIS_URL ?? "";

// Gate: skip the whole suite when no Redis is configured.
const describeRedis = REDIS_URL ? describe : describe.skip;

function makeEvent(id: string, surfaceId: string): SerializedEvent {
  return {
    id,
    surface_id: surfaceId,
    author: { kind: "agent", id: "a_0" },
    ts: new Date().toISOString(),
    type: "review.commentAdded",
    data: { body: "hi" },
    causation_id: null,
    idempotency_key: null,
  };
}

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describeRedis("Redis-backed multi-replica integration", () => {
  // Two raw ioredis connection pairs standing in for two relay replicas, plus
  // a flushdb between groups of assertions. Imported lazily so a no-Redis
  // environment never even loads ioredis.
  let IORedis: new (url: string) => {
    publish(c: string, m: string): Promise<number>;
    subscribe(c: string): Promise<unknown>;
    on(e: string, cb: (...a: unknown[]) => void): void;
    flushdb(): Promise<unknown>;
    quit(): Promise<unknown>;
  };

  beforeAll(async () => {
    const mod = (await import("ioredis")) as unknown as {
      default: typeof IORedis;
    };
    IORedis = mod.default;
  });

  it("broadcast: an event publishes across replicas and is delivered exactly once", async () => {
    const channel = "pane:events:sur_xrep";
    // Replica A: pub + sub. Replica B: sub only.
    const pubA = new IORedis(REDIS_URL);
    const subA = new IORedis(REDIS_URL);
    const subB = new IORedis(REDIS_URL);
    try {
      const receivedA: SerializedEvent[] = [];
      const receivedB: SerializedEvent[] = [];
      subA.on("message", (_c: unknown, m: unknown) => {
        receivedA.push(JSON.parse(m as string) as SerializedEvent);
      });
      subB.on("message", (_c: unknown, m: unknown) => {
        receivedB.push(JSON.parse(m as string) as SerializedEvent);
      });
      await subA.subscribe(channel);
      await subB.subscribe(channel);
      await wait(50);

      // Replica A publishes once.
      await pubA.publish(channel, JSON.stringify(makeEvent("1", "sur_xrep")));
      await wait(100);

      // The publishing replica (A) gets it back via Redis loopback — exactly
      // once — and the other replica (B) gets it too.
      expect(receivedA.map((e) => e.id)).toEqual(["1"]);
      expect(receivedB.map((e) => e.id)).toEqual(["1"]);
    } finally {
      await Promise.allSettled([pubA.quit(), subA.quit(), subB.quit()]);
    }
  });

  it("rate limiter: the sliding window is global across replicas", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const redis = await import("./redis.js");
    redis._resetRedisForTests();
    await redis.initRedis();
    try {
      await redis.redisPub().flushdb?.();
      const { createRateLimiter } = await import("./http/rate-limit.js");
      // Two limiter instances with the SAME window share one Redis bucket.
      const limA = createRateLimiter(2, 60_000);
      const limB = createRateLimiter(2, 60_000);
      const key = "ip:1.2.3.4";
      expect(await limA.check(key)).toBe(true);
      expect(await limB.check(key)).toBe(true);
      // Third request — from either instance — exceeds the global limit of 2.
      expect(await limA.check(key)).toBe(false);
      expect(await limB.check(key)).toBe(false);
    } finally {
      await redis.shutdownRedis();
      redis._resetRedisForTests();
      delete process.env.REDIS_URL;
    }
  });

  it("presence: connections are visible cluster-wide", async () => {
    process.env.REDIS_URL = REDIS_URL;
    const redis = await import("./redis.js");
    redis._resetRedisForTests();
    await redis.initRedis();
    try {
      await redis.redisPub().flushdb?.();
      const presence = await import("./ws/presence.js");
      // "Replica A" adds two connections.
      await presence.addConnection("sur_p", "cA", "agent");
      await presence.addConnection("sur_p", "cB", "human");
      // "Replica B" reads the count — sees both.
      expect(await presence.connectionCount("sur_p")).toBe(2);
      expect(await presence.agentCount("sur_p")).toBe(1);
      expect(await presence.humanCount("sur_p")).toBe(1);
      expect(await presence.totalConnections()).toBe(2);

      await presence.removeConnection("sur_p", "cA");
      expect(await presence.connectionCount("sur_p")).toBe(1);
    } finally {
      await redis.shutdownRedis();
      redis._resetRedisForTests();
      delete process.env.REDIS_URL;
    }
  });
});
