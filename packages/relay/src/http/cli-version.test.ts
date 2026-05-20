// Unit tests for cliVersionMiddleware.
//
// Exercises the four corners of the version-skew check:
//   - MIN_CLI_VERSION=0.0.0 → fast-path no-op (header is ignored)
//   - MIN_CLI_VERSION>0, header absent → pass (library / non-CLI caller)
//   - MIN_CLI_VERSION>0, header lower → 426 cli_upgrade_required
//   - MIN_CLI_VERSION>0, header equal or higher → pass
//
// Plus the corner cases:
//   - malformed header (e.g. "0.0.2-beta", "garbage") is treated as missing,
//     not as 0.0.0; we don't 400 on header hygiene
//   - mid-segment comparisons (0.1.0 vs 0.0.99) follow real semver, not
//     lexicographic ordering

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Config } from "../config.js";
import { ApiError } from "./errors.js";
import { cliVersionMiddleware } from "./cli-version.js";

/** Build a minimal app exposing GET /v1/x guarded by the middleware. */
function appWith(minVersion: string): Hono {
  const config = { MIN_CLI_VERSION: minVersion } as Config;
  const app = new Hono();
  app.use("/v1/*", cliVersionMiddleware(config));
  app.get("/v1/x", (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        },
        // Hono Status type doesn't include 426; cast for the test.
        err.status as 426 | 200 | 400 | 401 | 404 | 410 | 413 | 422 | 429,
      );
    }
    return c.json({ error: { code: "internal" } }, 500);
  });
  return app;
}

async function get(
  app: Hono,
  header: string | null,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (header !== null) headers["x-pane-cli-version"] = header;
  const res = await app.fetch(
    new Request("http://t/v1/x", { method: "GET", headers }),
  );
  const body = await res.json();
  return { status: res.status, body };
}

describe("cliVersionMiddleware", () => {
  it("is a no-op when MIN_CLI_VERSION is at its 0.0.0 default", async () => {
    // Even a missing or absurdly-low header passes without inspection.
    const app = appWith("0.0.0");
    expect((await get(app, null)).status).toBe(200);
    expect((await get(app, "0.0.0")).status).toBe(200);
    expect((await get(app, "0.0.1")).status).toBe(200);
  });

  it("passes a request without the version header (library / non-CLI caller)", async () => {
    // Header absence MUST be treated as "this caller isn't the pane CLI" —
    // the relay can't tell a third-party @paneui/core consumer to upgrade
    // its CLI because it doesn't have one.
    const app = appWith("0.0.5");
    const r = await get(app, null);
    expect(r.status).toBe(200);
  });

  it("rejects a strictly-lower version with 426 cli_upgrade_required", async () => {
    const app = appWith("0.0.5");
    const r = await get(app, "0.0.4");
    expect(r.status).toBe(426);
    const body = r.body as {
      error: {
        code: string;
        message: string;
        details: { min_version: string; your_version: string };
      };
    };
    expect(body.error.code).toBe("cli_upgrade_required");
    expect(body.error.details.min_version).toBe("0.0.5");
    expect(body.error.details.your_version).toBe("0.0.4");
  });

  it("passes a request with the exact MIN_CLI_VERSION", async () => {
    // The check is strictly less-than, not less-than-or-equal — a CLI at
    // exactly the minimum is by definition supported.
    const app = appWith("0.0.5");
    expect((await get(app, "0.0.5")).status).toBe(200);
  });

  it("passes a request with a higher version", async () => {
    const app = appWith("0.0.5");
    expect((await get(app, "0.0.6")).status).toBe(200);
    expect((await get(app, "1.0.0")).status).toBe(200);
  });

  it("treats a malformed version header as absent, not as 0.0.0", async () => {
    // We don't want to 426 a caller because their string had a stray suffix
    // — that's a header-hygiene problem the relay isn't here to police.
    // The skew check fires only on a clean semver that's actually lower.
    const app = appWith("0.0.5");
    expect((await get(app, "0.0.2-beta")).status).toBe(200);
    expect((await get(app, "garbage")).status).toBe(200);
    expect((await get(app, "")).status).toBe(200);
  });

  it("compares versions semver-style, not lexicographically", async () => {
    // 0.0.99 < 0.1.0 numerically; the naive string compare would have it the
    // other way around. This is the regression most likely to creep in if
    // someone replaces compareSemver with a one-liner.
    const app = appWith("0.1.0");
    const r = await get(app, "0.0.99");
    expect(r.status).toBe(426);
    expect((await get(app, "0.1.0")).status).toBe(200);
    // And 1.0.0 vs 0.10.0 — major must beat minor.
    const app2 = appWith("1.0.0");
    expect((await get(app2, "0.10.0")).status).toBe(426);
  });
});
