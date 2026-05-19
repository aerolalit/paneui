// Unit tests for PaneClient.call, exercised through the `fetch` override.

import { describe, it, expect } from "vitest";
import { PaneClient, PaneApiError } from "./client.js";

/** Build a client with a stubbed fetch. */
function clientWith(fetchImpl: typeof fetch): PaneClient {
  return new PaneClient({
    url: "https://relay.test/",
    apiKey: "k_test",
    fetch: fetchImpl,
  });
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
    const c = clientWith(async () =>
      res({ status: 200, body: JSON.stringify({ hello: "world" }) }),
    );
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
    expect((r.data as { error: { code: string } }).error.code).toBe(
      "fetch_error",
    );
    expect((r.data as { error: { message: string } }).error.message).toContain(
      "ECONNREFUSED",
    );
  });

  it("captures a non-JSON body instead of discarding it", async () => {
    const c = clientWith(async () =>
      res({ status: 502, ok: false, body: "<html>Bad Gateway</html>" }),
    );
    const r = await c.call("GET", "/v1/x");
    expect(r.ok).toBe(false);
    const err = (
      r.data as { error: { code: string; details: { body: string } } }
    ).error;
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

  it("populates hint/retryable/docsUrl from the relay error envelope", async () => {
    const c = clientWith(async () =>
      res({
        status: 429,
        ok: false,
        body: JSON.stringify({
          error: {
            code: "rate_limited",
            message: "slow down",
            hint: "wait and retry",
            retryable: true,
            docs_url: "https://example.test/docs#rate",
          },
        }),
      }),
    );
    const err = await c.getSession("ses_x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaneApiError);
    const e = err as PaneApiError;
    expect(e.code).toBe("rate_limited");
    expect(e.hint).toBe("wait and retry");
    expect(e.retryable).toBe(true);
    expect(e.docsUrl).toBe("https://example.test/docs#rate");
  });

  it("leaves the new fields undefined when the relay omits them", async () => {
    const c = clientWith(async () =>
      res({
        status: 404,
        ok: false,
        body: JSON.stringify({ error: { code: "not_found" } }),
      }),
    );
    const err = (await c
      .getSession("ses_x")
      .catch((e: unknown) => e)) as PaneApiError;
    expect(err.hint).toBeUndefined();
    expect(err.retryable).toBeUndefined();
    expect(err.docsUrl).toBeUndefined();
  });

  it("throws invalid_response when a 2xx body is not an object", async () => {
    const c = clientWith(async () => res({ status: 200, body: "null" }));
    await expect(c.getSession("ses_x")).rejects.toBeInstanceOf(PaneApiError);
    await expect(c.getSession("ses_x")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("returns the parsed body on success", async () => {
    const c = clientWith(async () =>
      res({
        status: 200,
        body: JSON.stringify({ session_id: "ses_x", status: "open" }),
      }),
    );
    const s = await c.getSession("ses_x");
    expect(s.session_id).toBe("ses_x");
  });
});

describe("PaneClient artifact operations", () => {
  /** Capture the request method/path/body of a single call. */
  function capturingClient(body: string, status = 200) {
    let seen: { method: string; url: string; body: unknown } | undefined;
    const c = clientWith(async (url, init) => {
      seen = {
        method: (init?.method as string) ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      return res({ status, body });
    });
    return { c, seen: () => seen! };
  }

  it("createArtifact POSTs /v1/artifacts and returns artifact_id + version", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({ artifact_id: "art_1", version: 1 }),
      201,
    );
    const out = await c.createArtifact({
      name: "PR Review",
      slug: "pr-review",
      tags: ["pr", "review"],
      source: "<html></html>",
      type: "html-inline",
      event_schema: { events: {} },
    });
    expect(out).toEqual({ artifact_id: "art_1", version: 1 });
    expect(seen().method).toBe("POST");
    expect(seen().url).toBe("https://relay.test/v1/artifacts");
    expect(seen().body).toMatchObject({ name: "PR Review", slug: "pr-review" });
  });

  it("createArtifactVersion POSTs /v1/artifacts/:id/versions", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({ artifact_id: "art_1", version: 2 }),
      201,
    );
    const out = await c.createArtifactVersion("pr-review", {
      source: "<html>v2</html>",
      type: "html-inline",
      event_schema: { events: {} },
    });
    expect(out.version).toBe(2);
    expect(seen().method).toBe("POST");
    expect(seen().url).toBe(
      "https://relay.test/v1/artifacts/pr-review/versions",
    );
  });

  it("updateArtifact PATCHes /v1/artifacts/:id and returns the summary", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({
        id: "art_1",
        slug: "pr-review",
        name: "Renamed",
        description: null,
        tags: null,
        latest_version: 1,
        last_used_at: null,
      }),
    );
    const out = await c.updateArtifact("art_1", { name: "Renamed" });
    expect(out.name).toBe("Renamed");
    expect(seen().method).toBe("PATCH");
    expect(seen().url).toBe("https://relay.test/v1/artifacts/art_1");
    expect(seen().body).toEqual({ name: "Renamed" });
  });

  it("searchArtifacts unwraps the { artifacts: [] } envelope", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({ artifacts: [{ id: "art_1", slug: "pr-review" }] }),
    );
    const out = await c.searchArtifacts("review");
    expect(out).toHaveLength(1);
    expect(out[0]!.slug).toBe("pr-review");
    expect(seen().url).toBe("https://relay.test/v1/artifacts?q=review");
  });

  it("searchArtifacts omits the query string when no query is given", async () => {
    const { c, seen } = capturingClient(JSON.stringify({ artifacts: [] }));
    await c.searchArtifacts();
    expect(seen().url).toBe("https://relay.test/v1/artifacts");
  });

  it("getArtifact GETs /v1/artifacts/:id", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({ id: "art_1", versions: [] }),
    );
    const out = await c.getArtifact("pr-review");
    expect(out.id).toBe("art_1");
    expect(seen().method).toBe("GET");
    expect(seen().url).toBe("https://relay.test/v1/artifacts/pr-review");
  });

  it("getArtifactVersion GETs /v1/artifacts/:id/versions/:version", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({ id: "ver_1", version: 3 }),
    );
    const out = await c.getArtifactVersion("art_1", 3);
    expect(out.version).toBe(3);
    expect(seen().url).toBe("https://relay.test/v1/artifacts/art_1/versions/3");
  });

  it("throws PaneApiError on a 404 from an artifact route", async () => {
    const c = clientWith(async () =>
      res({
        status: 404,
        ok: false,
        body: JSON.stringify({ error: { code: "not_found" } }),
      }),
    );
    await expect(c.getArtifact("missing")).rejects.toMatchObject({
      name: "PaneApiError",
      status: 404,
      code: "not_found",
    });
  });
});

describe("PaneClient.wsBaseUrl", () => {
  it("maps https to wss", () => {
    expect(
      new PaneClient({ url: "https://relay.test", apiKey: "k" }).wsBaseUrl,
    ).toBe("wss://relay.test");
  });
  it("maps http to ws", () => {
    expect(
      new PaneClient({ url: "http://relay.test", apiKey: "k" }).wsBaseUrl,
    ).toBe("ws://relay.test");
  });
});
