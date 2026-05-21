// Unit tests for the scan-hook caller. Mocks `fetch` to simulate the
// scanner; verifies HMAC signing, signature verification on the response,
// and fail-closed behaviour on timeout / bad status / bad signature.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { callScanHook, type ScanRequestBody } from "./scan-hook.js";

const FAKE_HOOK_URL = "https://scanner.example.test/scan";

let originalFetch: typeof fetch;

// Force `getMasterKey()` to return a deterministic 32-byte key so HMACs are
// reproducible. The crypto module reads PANE_SECRET_KEY at first call.
beforeEach(() => {
  process.env.PANE_SECRET_KEY = Buffer.alloc(32, 0x42).toString("base64");
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function hmacOf(body: string): string {
  return createHmac("sha256", Buffer.alloc(32, 0x42))
    .update(body, "utf8")
    .digest("hex");
}

function fakeConfig(): {
  BLOB_SCAN_HOOK: string;
  BLOB_SCAN_TIMEOUT_MS: number;
} {
  return {
    BLOB_SCAN_HOOK: FAKE_HOOK_URL,
    BLOB_SCAN_TIMEOUT_MS: 1000,
  };
}

const PAYLOAD: ScanRequestBody = {
  blob_id: "cmpf12345",
  scope: "agent",
  mime: "image/jpeg",
  size: 1234,
  sha256: "a".repeat(64),
  download_url: "https://relay.example/b/paneb_aaaa",
};

describe("callScanHook — happy path", () => {
  it("posts the signed body and returns a clean verdict", async () => {
    const responseBody = JSON.stringify({ verdict: "clean" });
    const responseSig = hmacOf(responseBody);

    globalThis.fetch = vi.fn(async (input, init) => {
      const url =
        input instanceof Request ? input.url : (input as string).toString();
      expect(url).toBe(FAKE_HOOK_URL);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-pane-scan-signature"]).toBe(
        hmacOf(init!.body as string),
      );
      return new Response(responseBody, {
        status: 200,
        headers: { "x-pane-scan-signature": responseSig },
      });
    }) as unknown as typeof fetch;

    const verdict = await callScanHook(fakeConfig() as never, PAYLOAD);
    expect(verdict).toEqual({ verdict: "clean" });
  });

  it("returns infected verdicts verbatim", async () => {
    const responseBody = JSON.stringify({
      verdict: "infected",
      reason: "EICAR test signature",
    });
    const responseSig = hmacOf(responseBody);

    globalThis.fetch = vi.fn(
      async () =>
        new Response(responseBody, {
          status: 200,
          headers: { "x-pane-scan-signature": responseSig },
        }),
    ) as unknown as typeof fetch;

    const verdict = await callScanHook(fakeConfig() as never, PAYLOAD);
    expect(verdict).toEqual({
      verdict: "infected",
      reason: "EICAR test signature",
    });
  });
});

describe("callScanHook — fail-closed", () => {
  it("throws on non-2xx response", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(callScanHook(fakeConfig() as never, PAYLOAD)).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("throws when the response signature is missing", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ verdict: "clean" }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    await expect(callScanHook(fakeConfig() as never, PAYLOAD)).rejects.toThrow(
      /Signature/,
    );
  });

  it("throws when the response signature is wrong", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ verdict: "clean" }), {
          status: 200,
          headers: { "x-pane-scan-signature": "deadbeef".padStart(64, "0") },
        }),
    ) as unknown as typeof fetch;
    await expect(callScanHook(fakeConfig() as never, PAYLOAD)).rejects.toThrow(
      /signature did not verify/,
    );
  });

  it("throws when the verdict is malformed", async () => {
    const body = "not json at all";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "x-pane-scan-signature": hmacOf(body) },
        }),
    ) as unknown as typeof fetch;
    await expect(callScanHook(fakeConfig() as never, PAYLOAD)).rejects.toThrow(
      /valid JSON/,
    );
  });

  it("throws on an unknown verdict value", async () => {
    const body = JSON.stringify({ verdict: "weird" });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "x-pane-scan-signature": hmacOf(body) },
        }),
    ) as unknown as typeof fetch;
    await expect(callScanHook(fakeConfig() as never, PAYLOAD)).rejects.toThrow(
      /unknown verdict/,
    );
  });
});
