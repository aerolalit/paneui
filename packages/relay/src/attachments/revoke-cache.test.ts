// Unit tests for the in-memory revoke cache. Verifies idempotent add,
// hit/miss semantics, and FIFO eviction at the capacity ceiling.

import { describe, it, expect } from "vitest";
import { makeRevokeCache } from "./revoke-cache.js";

describe("makeRevokeCache", () => {
  it("starts empty", () => {
    const c = makeRevokeCache();
    expect(c.size()).toBe(0);
    expect(c.has("anything")).toBe(false);
  });

  it("add → has true for that key", () => {
    const c = makeRevokeCache();
    c.add("abc");
    expect(c.has("abc")).toBe(true);
    expect(c.has("def")).toBe(false);
  });

  it("add is idempotent (no size growth)", () => {
    const c = makeRevokeCache();
    c.add("abc");
    c.add("abc");
    c.add("abc");
    expect(c.size()).toBe(1);
  });

  it("evicts the oldest entry at capacity (FIFO)", () => {
    const c = makeRevokeCache(3);
    c.add("a");
    c.add("b");
    c.add("c");
    expect(c.size()).toBe(3);
    expect(c.has("a")).toBe(true);

    c.add("d");
    expect(c.size()).toBe(3);
    // `a` is the oldest — evicted; the rest stay.
    expect(c.has("a")).toBe(false);
    expect(c.has("b")).toBe(true);
    expect(c.has("c")).toBe(true);
    expect(c.has("d")).toBe(true);
  });

  it("clear() resets to empty", () => {
    const c = makeRevokeCache();
    c.add("a");
    c.add("b");
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.has("a")).toBe(false);
  });
});
