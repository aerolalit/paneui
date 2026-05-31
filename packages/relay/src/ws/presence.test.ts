// Unit tests for the presence registry's in-process (no-Redis) backend.
//
// REDIS_URL is unset in the unit-test environment, so `redisEnabled()` is
// false and every function uses the in-process Map. The functions are async
// in both backends — every assertion awaits them — and resolve immediately on
// the in-process path. The Redis-backed path is covered by the env-gated
// integration test (see redis.integration.test.ts).

import { describe, it, expect, beforeEach } from "vitest";
import {
  addConnection,
  removeConnection,
  refreshSession,
  agentCount,
  humanCount,
  connectionCount,
  totalConnections,
  _resetPresenceForTests,
} from "./presence.js";

beforeEach(() => {
  _resetPresenceForTests();
});

describe("presence (in-process backend, REDIS_URL unset)", () => {
  it("counts agent and human connections per surface", async () => {
    await addConnection("sur_a", "c1", "agent");
    await addConnection("sur_a", "c2", "human");
    await addConnection("sur_a", "c3", "agent");

    expect(await agentCount("sur_a")).toBe(2);
    expect(await humanCount("sur_a")).toBe(1);
    expect(await connectionCount("sur_a")).toBe(3);
  });

  it("an unknown surface has zero connections", async () => {
    expect(await agentCount("nope")).toBe(0);
    expect(await connectionCount("nope")).toBe(0);
  });

  it("removeConnection drops a connection and prunes the empty surface", async () => {
    await addConnection("sur_b", "c1", "agent");
    await removeConnection("sur_b", "c1");
    expect(await connectionCount("sur_b")).toBe(0);
    // Removing again is a harmless no-op.
    await removeConnection("sur_b", "c1");
    expect(await connectionCount("sur_b")).toBe(0);
  });

  it("totalConnections sums across surfaces and filters by kind", async () => {
    await addConnection("s1", "c1", "agent");
    await addConnection("s1", "c2", "human");
    await addConnection("s2", "c3", "agent");

    expect(await totalConnections()).toBe(3);
    expect(await totalConnections("agent")).toBe(2);
    expect(await totalConnections("human")).toBe(1);
  });

  it("refreshSession is a no-op when Redis is off", async () => {
    // Must not throw, must not affect counts.
    await addConnection("s3", "c1", "agent");
    await refreshSession("s3");
    expect(await connectionCount("s3")).toBe(1);
  });

  it("every function returns a Promise (single code path for callers)", () => {
    expect(addConnection("s", "c", "agent")).toBeInstanceOf(Promise);
    expect(removeConnection("s", "c")).toBeInstanceOf(Promise);
    expect(refreshSession("s")).toBeInstanceOf(Promise);
    expect(agentCount("s")).toBeInstanceOf(Promise);
    expect(humanCount("s")).toBeInstanceOf(Promise);
    expect(connectionCount("s")).toBeInstanceOf(Promise);
    expect(totalConnections()).toBeInstanceOf(Promise);
  });
});
