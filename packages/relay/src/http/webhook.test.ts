import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldFire, fire, WEBHOOK_TIMEOUT_MS } from "./webhook.js";
import type { SerializedEvent } from "../types.js";

// F-14 — `fire` now re-validates the URL against the SSRF guard at send time.
// The fire-behaviour tests below use `.test` hostnames that never resolve in
// DNS, so without this stub the guard would abort every send before fetch and
// the retry/redirect assertions would never run. Stub it to a pass-through so
// these tests keep exercising the fetch path; the dedicated "fire-time SSRF
// re-validation" block below removes the stub to test the guard for real.
vi.mock("./ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf.js")>();
  return {
    ...actual,
    assertSafeWebhookUrl: vi.fn().mockResolvedValue(undefined),
  };
});

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
    pane_id: "sess_1",
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

describe("fire (SSRF: redirects are not followed)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const event: SerializedEvent = {
    id: "evt_1",
    pane_id: "sess_1",
    author: { kind: "agent", id: "agent_1" },
    ts: "2026-01-01T00:00:00.000Z",
    type: "review.commentAdded",
    data: {},
    causation_id: null,
    idempotency_key: null,
  };

  it("requests fetch with redirect: 'manual' so a 3xx is never chased", async () => {
    // A target that always 302s. With redirect: "manual" the platform fetch
    // panes an opaqueredirect response (status 0) instead of following the
    // Location — so the relay cannot be bounced to an internal address.
    const inits: RequestInit[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init: RequestInit) => {
        inits.push(init);
        return Promise.resolve({
          ok: false,
          status: 0,
          type: "opaqueredirect" as ResponseType,
        } as Response);
      });
    vi.stubGlobal("fetch", fetchMock);

    await fire(
      { url: "https://validated-public.test/hook", secret: "s" },
      "sess_1",
      event,
    );

    // Every attempt must opt out of redirect-following.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const init of inits) {
      expect(init.redirect).toBe("manual");
    }
  });

  it("treats a 3xx redirect as a failed delivery and retries (does not return early)", async () => {
    // A plain 302 (some runtimes pane the status rather than an
    // opaqueredirect). It is NOT a 2xx, so fire() must keep retrying and
    // never treat it as a successful delivery.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      type: "basic" as ResponseType,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fire(
      { url: "https://validated-public.test/hook", secret: "s" },
      "sess_1",
      event,
    );

    // 1 attempt + 2 retries — a 302 is a failed delivery, not a success.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toBeUndefined();
  });

  it("a 2xx still short-circuits the retry loop (redirect handling is narrow)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      type: "basic" as ResponseType,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await fire(
      { url: "https://validated-public.test/hook", secret: "s" },
      "sess_1",
      event,
    );

    // Delivered on the first attempt — no retries.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fire (F-14: fire-time SSRF re-validation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const event: SerializedEvent = {
    id: "evt_1",
    pane_id: "sess_1",
    author: { kind: "agent", id: "agent_1" },
    ts: "2026-01-01T00:00:00.000Z",
    type: "review.commentAdded",
    data: {},
    causation_id: null,
    idempotency_key: null,
  };

  it("does NOT send when the URL fails the fire-time guard (DNS-rebinding window)", async () => {
    // Simulate the URL now resolving to a blocked/internal address at fire
    // time (the rebind). The guard rejects; fire() must abort before fetch.
    const ssrf = await import("./ssrf.js");
    vi.mocked(ssrf.assertSafeWebhookUrl).mockRejectedValueOnce(
      new Error("callback.url resolves to a non-routable address"),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fire(
      { url: "https://rebinds-to-internal.example/hook", secret: "s" },
      "sess_1",
      event,
    );

    // Guard tripped → no outbound request at all.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("still sends to a URL that passes the fire-time guard", async () => {
    const ssrf = await import("./ssrf.js");
    vi.mocked(ssrf.assertSafeWebhookUrl).mockResolvedValueOnce(undefined);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      type: "basic" as ResponseType,
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await fire(
      { url: "https://validated-public.test/hook", secret: "s" },
      "sess_1",
      event,
    );

    // Guard passed → the single happy-path delivery still fires.
    expect(ssrf.assertSafeWebhookUrl).toHaveBeenCalledWith(
      "https://validated-public.test/hook",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the send for a literal internal IP via the REAL guard", async () => {
    // No per-test stub override here — exercise the real assertSafeWebhookUrl
    // against a literal link-local/metadata IP, which it rejects synchronously
    // (no DNS needed). Proves the wiring trips on a genuinely blocked target.
    const real = await vi.importActual<typeof import("./ssrf.js")>("./ssrf.js");
    const ssrf = await import("./ssrf.js");
    vi.mocked(ssrf.assertSafeWebhookUrl).mockImplementation(
      real.assertSafeWebhookUrl,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fire(
      { url: "http://169.254.169.254/latest/meta-data/", secret: "s" },
      "sess_1",
      event,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
