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

  it("posts to /v1/register with an empty body when no name is given", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    await registerAgent({
      url: "https://relay.test",
      fetch: async (url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return res({
          status: 201,
          body: JSON.stringify({
            agent_id: "a",
            api_key: "k",
            key_prefix: "p",
          }),
        });
      },
    });
    expect(seenUrl).toBe("https://relay.test/v1/register");
    expect(seenInit!.method).toBe("POST");
    expect(JSON.parse(seenInit!.body as string)).toEqual({});
  });

  it("posts the optional name to /v1/register", async () => {
    let seenInit: RequestInit | undefined;
    await registerAgent({
      url: "https://relay.test",
      name: "ci-bot",
      fetch: async (_url, init) => {
        seenInit = init;
        return res({
          status: 201,
          body: JSON.stringify({
            agent_id: "a",
            api_key: "k",
            key_prefix: "p",
          }),
        });
      },
    });
    expect(JSON.parse(seenInit!.body as string)).toEqual({ name: "ci-bot" });
  });

  it("throws PaneApiError on 429 (rate limited)", async () => {
    try {
      await registerAgent({
        url: "https://relay.test",
        fetch: async () =>
          res({
            status: 429,
            body: JSON.stringify({
              error: {
                code: "rate_limited",
                message: "registration rate limit exceeded",
              },
            }),
          }),
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PaneApiError);
      expect((e as PaneApiError).status).toBe(429);
      expect((e as PaneApiError).code).toBe("rate_limited");
    }
  });

  it("maps a network failure to a fetch_error PaneApiError", async () => {
    try {
      await registerAgent({
        url: "https://relay.test",
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
