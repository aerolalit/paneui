import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldFire, fire, WEBHOOK_TIMEOUT_MS } from "./webhook.js";
import type { SerializedEvent } from "../types.js";

describe("shouldFire (glob)", () => {
  it("exact literal match", () => {
    expect(shouldFire("review.commentAdded", ["review.commentAdded"])).toBe(
      true,
    );
    expect(shouldFire("review.approved", ["review.commentAdded"])).toBe(false);
  });

  it("prefix wildcard", () => {
    expect(shouldFire("review.commentAdded", ["review.*"])).toBe(true);
    expect(shouldFire("review.approved", ["review.*"])).toBe(true);
    expect(shouldFire("form.submitted", ["review.*"])).toBe(false);
  });

  it("multiple patterns: any matches", () => {
    const filter = ["review.*", "form.submitted"];
    expect(shouldFire("review.commentAdded", filter)).toBe(true);
    expect(shouldFire("form.submitted", filter)).toBe(true);
    expect(shouldFire("highlight.requested", filter)).toBe(false);
  });

  it("empty / nullish filter never matches", () => {
    expect(shouldFire("review.commentAdded", [])).toBe(false);
    expect(shouldFire("review.commentAdded", null)).toBe(false);
    expect(shouldFire("review.commentAdded", undefined)).toBe(false);
  });

  it("escapes regex specials in literal parts", () => {
    expect(shouldFire("a.b", ["a.b"])).toBe(true);
    // Without escaping, "a.b" pattern as regex would also match "aXb".
    expect(shouldFire("aXb", ["a.b"])).toBe(false);
  });
});

describe("fire (per-attempt timeout)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const event: SerializedEvent = {
    id: "evt_1",
    session_id: "sess_1",
    author: { kind: "agent", id: "agent_1" },
    ts: "2026-01-01T00:00:00.000Z",
    type: "review.commentAdded",
    data: {},
    causation_id: null,
    idempotency_key: null,
  };

  it("uses a per-attempt request timeout of ~10s", () => {
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts each attempt at the timeout and records the delivery failed", async () => {
    // Stub AbortSignal.timeout so the per-attempt timeout fires promptly
    // instead of after the real WEBHOOK_TIMEOUT_MS, keeping the test fast
    // while still exercising the abort path. Each call must produce a
    // distinct signal — fire() requests a fresh one per attempt.
    const requestedTimeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      requestedTimeouts.push(ms);
      return realTimeout(5); // abort quickly with a real TimeoutError
    });

    // A never-responding target: the fetch promise only settles when its
    // per-attempt AbortSignal fires. Without the timeout signal a hung
    // target would hang the retry loop forever.
    const signals: AbortSignal[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fire(
      { url: "https://example.test/hook", secret: "s", filter: ["*"] },
      "sess_1",
      event,
    );

    // 1 attempt + 2 retries — each made, each given its own timeout
    // signal, each aborted by the per-attempt timeout.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestedTimeouts).toEqual([
      WEBHOOK_TIMEOUT_MS,
      WEBHOOK_TIMEOUT_MS,
      WEBHOOK_TIMEOUT_MS,
    ]);
    expect(signals).toHaveLength(3);
    for (const signal of signals) {
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error).name).toBe("TimeoutError");
    }
    // fire() returns void once retries are exhausted — delivery failed.
    expect(result).toBeUndefined();
  });
});
