import { describe, it, expect, vi, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { shouldFire, fire, sendOnce, WEBHOOK_TIMEOUT_MS } from "./webhook.js";
import type { ResolvedSafeHost } from "./ssrf.js";
import type { SerializedEvent } from "../types.js";

// node:dns/promises is mocked so the REAL resolveSafeOutboundUrl path (used by
// the "resolves to a mix" / "all safe" tests below) can be driven with a
// controlled lookup result without touching real DNS. ESM module namespaces are
// frozen, so we cannot vi.spyOn(dns, "lookup") directly — we mock the module.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const mockLookup = vi.mocked(dnsLookup);

// `fire` resolves+pins the callback host via resolveSafeWebhookUrl at send
// time. The fire-behaviour tests below use hostnames that never resolve in DNS,
// so without this stub the guard would abort every send before the transport
// and the retry/redirect assertions would never run. Stub it to return a
// pinned public IP so these tests exercise the (separately mocked) send path;
// the dedicated "fire-time SSRF" block removes the stub to test the guard for
// real.
const PINNED: ResolvedSafeHost = {
  url: new URL("https://example.test/hook"),
  host: "example.test",
  address: "93.184.216.34",
  family: 4,
  wasLiteral: false,
};
vi.mock("./ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf.js")>();
  return {
    ...actual,
    resolveSafeWebhookUrl: vi.fn(async (url: string) => ({
      ...PINNED,
      url: new URL(url),
      host: new URL(url).hostname,
    })),
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

describe("fire (per-attempt timeout + retries)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses a per-attempt request timeout of ~10s", () => {
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
  });

  it("retries 1+2 times and surfaces the timeout to each attempt", async () => {
    // The pinned send rejects with a TimeoutError each time, exactly as the
    // node:http 'timeout' path does. fire() must attempt 3 times and pass the
    // configured timeout into each send.
    const timeouts: number[] = [];
    const webhook = await import("./webhook.js");
    const sendSpy = vi
      .spyOn(webhook._internals, "sendOnce")
      .mockImplementation(async (_pinned, _headers, _body, ms) => {
        timeouts.push(ms);
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      });

    const result = await fire(
      { url: "https://example.test/hook", secret: "s" },
      "sess_1",
      event,
    );

    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(timeouts).toEqual([
      WEBHOOK_TIMEOUT_MS,
      WEBHOOK_TIMEOUT_MS,
      WEBHOOK_TIMEOUT_MS,
    ]);
    expect(result).toBeUndefined();
  });
});

describe("fire (SSRF: redirects are not followed)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a 3xx as a failed delivery and retries (does not return early)", async () => {
    const webhook = await import("./webhook.js");
    const sendSpy = vi
      .spyOn(webhook._internals, "sendOnce")
      .mockResolvedValue({ status: 302, redirected: true });

    const result = await fire(
      { url: "https://validated-public.test/hook", secret: "s" },
      "sess_1",
      event,
    );

    // 1 attempt + 2 retries — a 302 is never followed and never a success.
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(result).toBeUndefined();
  });

  it("a 2xx short-circuits the retry loop", async () => {
    const webhook = await import("./webhook.js");
    const sendSpy = vi
      .spyOn(webhook._internals, "sendOnce")
      .mockResolvedValue({ status: 200, redirected: false });

    await fire(
      { url: "https://validated-public.test/hook", secret: "s" },
      "sess_1",
      event,
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("a non-2xx non-3xx (e.g. 500) is a failed delivery and retries", async () => {
    const webhook = await import("./webhook.js");
    const sendSpy = vi
      .spyOn(webhook._internals, "sendOnce")
      .mockResolvedValue({ status: 500, redirected: false });

    await fire(
      { url: "https://validated-public.test/hook", secret: "s" },
      "sess_1",
      event,
    );

    expect(sendSpy).toHaveBeenCalledTimes(3);
  });
});

describe("fire (pin-and-connect + HMAC + headers)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("passes the pinned host/IP and HMAC-signed headers to the send", async () => {
    const webhook = await import("./webhook.js");
    const captured: {
      pinned?: ResolvedSafeHost;
      headers?: Record<string, string>;
      body?: string;
    } = {};
    vi.spyOn(webhook._internals, "sendOnce").mockImplementation(
      async (pinned, headers, body) => {
        captured.pinned = pinned;
        captured.headers = headers;
        captured.body = body;
        return { status: 200, redirected: false };
      },
    );

    await fire(
      { url: "https://hook.example.test/cb?x=1", secret: "topsecret" },
      "sess_42",
      event,
    );

    // The send was pinned to the resolved IP, with the original hostname kept
    // for Host/SNI.
    expect(captured.pinned?.address).toBe(PINNED.address);
    expect(captured.pinned?.host).toBe("hook.example.test");

    // Signature: sha256 HMAC over `${ts}.${body}` with the secret.
    const ts = captured.headers!["X-Pane-Timestamp"]!;
    const expectedSig = createHmac("sha256", "topsecret")
      .update(`${ts}.${captured.body}`)
      .digest("hex");
    expect(captured.headers!["X-Pane-Signature"]).toBe(`sha256=${expectedSig}`);
    expect(captured.headers!["content-type"]).toBe("application/json");
    expect(JSON.parse(captured.body!)).toEqual({
      pane_id: "sess_42",
      event,
    });
  });
});

describe("fire (fire-time SSRF re-validation via resolve-and-pin)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("does NOT send when the host resolves to a blocked address (the rebind)", async () => {
    const ssrf = await import("./ssrf.js");
    vi.mocked(ssrf.resolveSafeWebhookUrl).mockRejectedValueOnce(
      new Error("callback.url resolves to a non-routable address"),
    );
    const webhook = await import("./webhook.js");
    const sendSpy = vi.spyOn(webhook._internals, "sendOnce");

    const result = await fire(
      { url: "https://rebinds-to-internal.example/hook", secret: "s" },
      "sess_1",
      event,
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("aborts the send for a literal internal IP via the REAL guard", async () => {
    // Exercise the real resolveSafeWebhookUrl against a literal link-local /
    // metadata IP, which it rejects synchronously (no DNS needed).
    const real = await vi.importActual<typeof import("./ssrf.js")>("./ssrf.js");
    const ssrf = await import("./ssrf.js");
    vi.mocked(ssrf.resolveSafeWebhookUrl).mockImplementation(
      real.resolveSafeWebhookUrl,
    );
    const webhook = await import("./webhook.js");
    const sendSpy = vi.spyOn(webhook._internals, "sendOnce");

    const result = await fire(
      { url: "http://169.254.169.254/latest/meta-data/", secret: "s" },
      "sess_1",
      event,
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("aborts when a public host resolves to a MIX including a blocked IP", async () => {
    // The dangerous DNS-rebinding shape: one public answer + one internal
    // answer. resolveSafeOutboundUrl must reject the whole host (every address
    // checked), so the relay never even picks the public IP — no send happens.
    const real = await vi.importActual<typeof import("./ssrf.js")>("./ssrf.js");
    const ssrf = await import("./ssrf.js");
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 }, // metadata IP smuggled in
    ] as never);

    // The resolver rejects the host outright.
    await expect(
      real.resolveSafeWebhookUrl("https://rebind-mix.example/hook"),
    ).rejects.toThrow(/non-routable/);

    // And via fire(): with the real resolver wired in, the mixed answer aborts
    // the send entirely — the relay never connects to the blocked IP.
    vi.mocked(ssrf.resolveSafeWebhookUrl).mockImplementation(
      real.resolveSafeWebhookUrl,
    );
    const webhook = await import("./webhook.js");
    const sendSpy = vi.spyOn(webhook._internals, "sendOnce");

    await fire(
      { url: "https://rebind-mix.example/hook", secret: "s" },
      "sess_1",
      event,
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sends, PINNED to the resolved IP, when the host resolves entirely to safe public IPs", async () => {
    const real = await vi.importActual<typeof import("./ssrf.js")>("./ssrf.js");
    const ssrf = await import("./ssrf.js");
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    vi.mocked(ssrf.resolveSafeWebhookUrl).mockImplementation(
      real.resolveSafeWebhookUrl,
    );
    const webhook = await import("./webhook.js");
    const sendSpy = vi
      .spyOn(webhook._internals, "sendOnce")
      .mockResolvedValue({ status: 200, redirected: false });

    await fire(
      { url: "https://safe-public.example/hook", secret: "s" },
      "sess_1",
      event,
    );

    // Delivered, and pinned to the exact resolved IP with the original hostname
    // preserved (for Host header + TLS SNI).
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const pinned = sendSpy.mock.calls[0]![0];
    expect(pinned.address).toBe("93.184.216.34");
    expect(pinned.host).toBe("safe-public.example");
  });
});

describe("sendOnce (real transport, http, pinned to loopback listener)", () => {
  let server: Server;
  let received: {
    method?: string;
    host?: string;
    sig?: string | string[];
    ts?: string | string[];
    ct?: string | string[];
    path?: string;
    body: string;
  };

  afterEach(() => {
    server?.close();
  });

  it("connects to the pinned IP, preserves Host header + path, does not follow redirect", async () => {
    received = { body: "" };
    server = createServer((req, res) => {
      received.method = req.method;
      received.host = req.headers.host;
      received.sig = req.headers["x-pane-signature"];
      received.ts = req.headers["x-pane-timestamp"];
      received.ct = req.headers["content-type"];
      received.path = req.url;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.body = body;
        // Reply with a redirect to prove sendOnce does NOT follow it.
        res.statusCode = 302;
        res.setHeader("location", "http://169.254.169.254/");
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    // Pin to the loopback listener but present a public-looking hostname as the
    // Host header / URL host (the URL drives Host + path; address drives dial).
    const pinned: ResolvedSafeHost = {
      url: new URL(`http://webhook.test:${port}/cb?x=1`),
      host: "webhook.test",
      address: "127.0.0.1",
      family: 4,
      wasLiteral: false,
    };

    const outcome = await sendOnce(
      pinned,
      {
        "content-type": "application/json",
        "X-Pane-Timestamp": "100",
        "X-Pane-Signature": "sha256=deadbeef",
      },
      JSON.stringify({ hello: "world" }),
      5000,
    );

    expect(outcome.status).toBe(302);
    expect(outcome.redirected).toBe(true);
    expect(received.method).toBe("POST");
    // Host header is the original hostname (with port), not the dialled IP.
    expect(received.host).toBe(`webhook.test:${port}`);
    expect(received.path).toBe("/cb?x=1");
    expect(received.sig).toBe("sha256=deadbeef");
    expect(received.ts).toBe("100");
    expect(received.ct).toBe("application/json");
    expect(received.body).toBe(JSON.stringify({ hello: "world" }));
  });

  it("reports a 2xx as a delivered (non-redirected) outcome", async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const pinned: ResolvedSafeHost = {
      url: new URL(`http://webhook.test:${port}/cb`),
      host: "webhook.test",
      address: "127.0.0.1",
      family: 4,
      wasLiteral: false,
    };

    const outcome = await sendOnce(pinned, {}, "{}", 5000);
    expect(outcome.status).toBe(204);
    expect(outcome.redirected).toBe(false);
  });
});
