// Unit tests for registerAgent, exercised through the `fetch` override.

import { describe, it, expect } from "vitest";
import { registerAgent } from "./register.js";
import { PaneApiError } from "./client.js";

/** Minimal Response-like stub for the fields registerAgent reads. */
function res(opts: { status: number; ok?: boolean; body?: string }): Response {
  return {
    status: opts.status,
    ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
    text: async () => opts.body ?? "",
  } as unknown as Response;
}

describe("registerAgent", () => {
  it("returns agent_id / api_key / key_prefix on 201", async () => {
    const result = await registerAgent({
      url: "https://relay.test/",
      registrationSecret: "s3cret",
      fetch: async () =>
        res({
          status: 201,
          body: JSON.stringify({
            agent_id: "agt_1",
            api_key: "pk_live_abc",
            key_prefix: "pk_live",
          }),
        }),
    });
    expect(result).toEqual({
      agent_id: "agt_1",
      api_key: "pk_live_abc",
      key_prefix: "pk_live",
    });
  });

  it("posts registration_secret and optional name to /v1/register", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    await registerAgent({
      url: "https://relay.test",
      registrationSecret: "s3cret",
      name: "ci-bot",
      fetch: async (url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return res({ status: 201, body: JSON.stringify({ agent_id: "a", api_key: "k", key_prefix: "p" }) });
      },
    });
    expect(seenUrl).toBe("https://relay.test/v1/register");
    expect(seenInit!.method).toBe("POST");
    expect(JSON.parse(seenInit!.body as string)).toEqual({
      registration_secret: "s3cret",
      name: "ci-bot",
    });
  });

  it("throws PaneApiError on 404 (registration disabled)", async () => {
    await expect(
      registerAgent({
        url: "https://relay.test",
        registrationSecret: "s3cret",
        fetch: async () =>
          res({ status: 404, body: JSON.stringify({ error: { code: "not_found", message: "nope" } }) }),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws PaneApiError on 401 (bad secret)", async () => {
    try {
      await registerAgent({
        url: "https://relay.test",
        registrationSecret: "wrong",
        fetch: async () =>
          res({
            status: 401,
            body: JSON.stringify({ error: { code: "unauthorized", message: "bad secret" } }),
          }),
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PaneApiError);
      expect((e as PaneApiError).status).toBe(401);
      expect((e as PaneApiError).code).toBe("unauthorized");
    }
  });

  it("maps a network failure to a fetch_error PaneApiError", async () => {
    try {
      await registerAgent({
        url: "https://relay.test",
        registrationSecret: "s3cret",
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PaneApiError);
      expect((e as PaneApiError).status).toBe(0);
      expect((e as PaneApiError).code).toBe("fetch_error");
    }
  });
});
