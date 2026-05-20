// Unit tests for PaneClient.getTaste / setTaste / clearTaste — wire shape,
// HTTP method routing, and PaneApiError propagation on non-2xx.

import { describe, it, expect } from "vitest";
import { PaneClient, PaneApiError } from "./client.js";

function clientWith(fetchImpl: typeof fetch): PaneClient {
  return new PaneClient({
    url: "https://relay.test/",
    apiKey: "k_test",
    fetch: fetchImpl,
  });
}

function res(opts: { status: number; ok?: boolean; body?: string }): Response {
  return {
    status: opts.status,
    ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
    text: async () => opts.body ?? "",
  } as unknown as Response;
}

describe("PaneClient.getTaste", () => {
  it("GETs /v1/taste and returns the parsed body", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const c = clientWith(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return res({
        status: 200,
        body: JSON.stringify({
          taste: "- denser",
          updated_at: "2026-05-20T00:00:00.000Z",
          bytes: 9,
        }),
      });
    });
    const info = await c.getTaste();
    expect(seenUrl).toBe("https://relay.test/v1/taste");
    expect(seenInit!.method).toBe("GET");
    expect(info.taste).toBe("- denser");
    expect(info.bytes).toBe(9);
    expect(info.updated_at).toBe("2026-05-20T00:00:00.000Z");
  });

  it("throws PaneApiError on a non-2xx", async () => {
    const c = clientWith(async () =>
      res({
        status: 401,
        ok: false,
        body: JSON.stringify({ error: { code: "unauthorized" } }),
      }),
    );
    await expect(c.getTaste()).rejects.toBeInstanceOf(PaneApiError);
  });
});

describe("PaneClient.setTaste", () => {
  it("PUTs /v1/taste with the body and returns the parsed result", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const c = clientWith(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return res({
        status: 200,
        body: JSON.stringify({
          taste: "new notes",
          updated_at: "2026-05-20T00:00:00.000Z",
          bytes: 9,
        }),
      });
    });
    const info = await c.setTaste("new notes");
    expect(seenUrl).toBe("https://relay.test/v1/taste");
    expect(seenInit!.method).toBe("PUT");
    expect(JSON.parse(seenInit!.body as string)).toEqual({
      taste: "new notes",
    });
    expect(info.taste).toBe("new notes");
  });

  it("propagates a 413 as a PaneApiError", async () => {
    const c = clientWith(async () =>
      res({
        status: 413,
        ok: false,
        body: JSON.stringify({ error: { code: "payload_too_large" } }),
      }),
    );
    await expect(c.setTaste("huge")).rejects.toBeInstanceOf(PaneApiError);
  });
});

describe("PaneClient.clearTaste", () => {
  it("DELETEs /v1/taste and resolves on 204 with no body", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const c = clientWith(async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return res({ status: 204 });
    });
    await expect(c.clearTaste()).resolves.toBeUndefined();
    expect(seenUrl).toBe("https://relay.test/v1/taste");
    expect(seenInit!.method).toBe("DELETE");
  });

  it("throws PaneApiError on a non-2xx", async () => {
    const c = clientWith(async () =>
      res({
        status: 500,
        ok: false,
        body: JSON.stringify({ error: { code: "internal" } }),
      }),
    );
    await expect(c.clearTaste()).rejects.toBeInstanceOf(PaneApiError);
  });
});
