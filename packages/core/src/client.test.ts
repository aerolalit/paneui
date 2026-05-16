// Unit tests for PaneClient.call, exercised through the `fetch` override.

import { describe, it, expect } from "vitest";
import { PaneClient, PaneApiError } from "./client.js";

/** Build a client with a stubbed fetch. */
function clientWith(fetchImpl: typeof fetch): PaneClient {
  return new PaneClient({ url: "https://relay.test/", apiKey: "k_test", fetch: fetchImpl });
}

/** Minimal Response-like stub for the fields PaneClient.call reads. */
function res(opts: { status: number; ok?: boolean; body?: string }): Response {
  return {
    status: opts.status,
    ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
    text: async () => opts.body ?? "",
  } as unknown as Response;
}

describe("PaneClient.call", () => {
  it("parses a 2xx JSON body", async () => {
    const c = clientWith(async () => res({ status: 200, body: JSON.stringify({ hello: "world" }) }));
    const r = await c.call("GET", "/v1/x");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ hello: "world" });
  });

  it("handles a 204 with no body", async () => {
    const c = clientWith(async () => res({ status: 204 }));
    const r = await c.call("DELETE", "/v1/x");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(204);
    expect(r.data).toBeNull();
  });

  it("returns status 0 on a network failure", async () => {
    const c = clientWith(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await c.call("GET", "/v1/x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect((r.data as { error: { code: string } }).error.code).toBe("fetch_error");
    expect((r.data as { error: { message: string } }).error.message).toContain("ECONNREFUSED");
  });

  it("captures a non-JSON body instead of discarding it", async () => {
    const c = clientWith(async () =>
      res({ status: 502, ok: false, body: "<html>Bad Gateway</html>" }),
    );
    const r = await c.call("GET", "/v1/x");
    expect(r.ok).toBe(false);
    const err = (r.data as { error: { code: string; details: { body: string } } }).error;
    expect(err.code).toBe("non_json_response");
    expect(err.details.body).toContain("Bad Gateway");
  });

  it("sends bearer auth and JSON content-type when a body is present", async () => {
    let seen: RequestInit | undefined;
    const c = clientWith(async (_url, init) => {
      seen = init;
      return res({ status: 200, body: "{}" });
    });
    await c.call("POST", "/v1/x", { a: 1 });
    const headers = seen!.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer k_test");
    expect(headers["content-type"]).toBe("application/json");
    expect(seen!.body).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("PaneClient typed operations", () => {
  it("throws PaneApiError on a non-2xx response", async () => {
    const c = clientWith(async () =>
      res({
        status: 404,
        ok: false,
        body: JSON.stringify({ error: { code: "not_found", message: "nope" } }),
      }),
    );
    await expect(c.getSession("ses_x")).rejects.toMatchObject({
      name: "PaneApiError",
      status: 404,
      code: "not_found",
    });
  });

  it("throws invalid_response when a 2xx body is not an object", async () => {
    const c = clientWith(async () => res({ status: 200, body: "null" }));
    await expect(c.getSession("ses_x")).rejects.toBeInstanceOf(PaneApiError);
    await expect(c.getSession("ses_x")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("returns the parsed body on success", async () => {
    const c = clientWith(async () =>
      res({ status: 200, body: JSON.stringify({ session_id: "ses_x", status: "open" }) }),
    );
    const s = await c.getSession("ses_x");
    expect(s.session_id).toBe("ses_x");
  });
});

describe("PaneClient.wsBaseUrl", () => {
  it("maps https to wss", () => {
    expect(new PaneClient({ url: "https://relay.test", apiKey: "k" }).wsBaseUrl).toBe(
      "wss://relay.test",
    );
  });
  it("maps http to ws", () => {
    expect(new PaneClient({ url: "http://relay.test", apiKey: "k" }).wsBaseUrl).toBe(
      "ws://relay.test",
    );
  });
});
