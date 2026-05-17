// Unit tests for the sliding-window rate limiter and the X-Forwarded-For
// trust logic in clientIp().

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Context } from "hono";
import { createRateLimiter, clientIp } from "./rate-limit.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createRateLimiter", () => {
  it("allows up to `limit` requests then rejects within the window", () => {
    const lim = createRateLimiter(3, 1000);
    expect(lim.check("a")).toBe(true);
    expect(lim.check("a")).toBe(true);
    expect(lim.check("a")).toBe(true);
    expect(lim.check("a")).toBe(false);
  });

  it("keys are independent", () => {
    const lim = createRateLimiter(1, 1000);
    expect(lim.check("a")).toBe(true);
    expect(lim.check("a")).toBe(false);
    // A different key has its own fresh bucket.
    expect(lim.check("b")).toBe(true);
  });

  it("expires timestamps after the window so the bucket refills", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const lim = createRateLimiter(2, 1000);
    expect(lim.check("a")).toBe(true);
    expect(lim.check("a")).toBe(true);
    expect(lim.check("a")).toBe(false); // bucket full

    // Advance past the window — the old hits fall out of the sliding window.
    vi.setSystemTime(1001);
    expect(lim.check("a")).toBe(true);
    expect(lim.check("a")).toBe(true);
    expect(lim.check("a")).toBe(false);
  });

  it("limit <= 0 disables the limiter (every check passes)", () => {
    const off = createRateLimiter(0, 1000);
    for (let i = 0; i < 100; i++) expect(off.check("a")).toBe(true);
    const neg = createRateLimiter(-5, 1000);
    for (let i = 0; i < 100; i++) expect(neg.check("a")).toBe(true);
  });
});

// Build a minimal Context stand-in: a header getter plus a socket peer that
// getConnInfo() reads via c.env.incoming.socket.remoteAddress.
function fakeContext(opts: {
  headers?: Record<string, string>;
  peer?: string | null;
}): Context {
  const headers = opts.headers ?? {};
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
    env:
      opts.peer === undefined
        ? {}
        : { incoming: { socket: { remoteAddress: opts.peer } } },
  } as unknown as Context;
}

describe("clientIp — X-Forwarded-For trust", () => {
  it("ignores a spoofed XFF from a direct (untrusted) client", () => {
    // No trusted proxy configured: the socket peer is the only thing trusted.
    const c = fakeContext({
      headers: { "x-forwarded-for": "1.2.3.4" },
      peer: "203.0.113.9",
    });
    expect(clientIp(c, [])).toBe("203.0.113.9");
  });

  it("ignores XFF when the socket peer is not a configured trusted proxy", () => {
    const c = fakeContext({
      headers: { "x-forwarded-for": "1.2.3.4" },
      peer: "203.0.113.9", // attacker, not the trusted proxy
    });
    expect(clientIp(c, ["10.0.0.1"])).toBe("203.0.113.9");
  });

  it("honors XFF when the socket peer IS the trusted proxy", () => {
    const c = fakeContext({
      headers: { "x-forwarded-for": "198.51.100.7" },
      peer: "10.0.0.1",
    });
    expect(clientIp(c, ["10.0.0.1"])).toBe("198.51.100.7");
  });

  it("takes the last untrusted hop from a multi-hop XFF chain", () => {
    // chain: real-client, attacker-injected, then our two proxies appended.
    const c = fakeContext({
      headers: { "x-forwarded-for": "1.1.1.1, 198.51.100.7, 10.0.0.2" },
      peer: "10.0.0.1",
    });
    // 10.0.0.2 is trusted and skipped; 198.51.100.7 is the closest the edge saw.
    expect(clientIp(c, ["10.0.0.1", "10.0.0.2"])).toBe("198.51.100.7");
  });

  it("a spoofed XFF from a direct client cannot reset another client's bucket", () => {
    // Two distinct direct clients each spoofing the SAME victim XFF must NOT
    // collapse into one bucket — they bucket by their real socket address.
    const a = fakeContext({
      headers: { "x-forwarded-for": "9.9.9.9" },
      peer: "203.0.113.1",
    });
    const b = fakeContext({
      headers: { "x-forwarded-for": "9.9.9.9" },
      peer: "203.0.113.2",
    });
    expect(clientIp(a, [])).not.toBe(clientIp(b, []));

    // Concretely: the spoofed XFF does not advance the victim's bucket.
    const lim = createRateLimiter(1, 1000);
    expect(lim.check(clientIp(a, []))).toBe(true);
    // Same victim XFF, different real client — still its own bucket.
    expect(lim.check(clientIp(b, []))).toBe(true);
  });

  it("falls back to 'unknown' when there is no socket and no trusted XFF", () => {
    const c = fakeContext({
      headers: { "x-forwarded-for": "1.2.3.4" },
      peer: undefined,
    });
    expect(clientIp(c, [])).toBe("unknown");
  });
});
