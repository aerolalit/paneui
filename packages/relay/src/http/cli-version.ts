// Middleware: reject /v1/* requests from CLIs older than MIN_CLI_VERSION.
//
// Reads the `x-pane-cli-version` header set by @paneui/core's HTTP client
// (driven by @paneui/cli passing its own VERSION). When the header is
// present AND its semver is strictly lower than the configured
// MIN_CLI_VERSION, responds with 426 cli_upgrade_required so the CLI can
// print an actionable upgrade message.
//
// The header being absent is treated as "library / non-CLI caller" and
// always passes — only an explicit-but-too-old version trips the check.
//
// MIN_CLI_VERSION defaults to "0.0.0", so this middleware is a no-op until
// an operator explicitly raises the floor. That keeps it safe to wire up
// today and turn on per-relay later.

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";
import type { Config } from "../config.js";
import { errors } from "./errors.js";

// Strict three-segment semver comparator. Returns -1 / 0 / +1 just like
// Array#sort. Inputs are guaranteed to match /^\d+\.\d+\.\d+$/ — the config
// schema enforces that on MIN_CLI_VERSION, and the request-header path
// short-circuits anything else as "unparseable, treat as missing" below.
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Build the middleware for a given config. Curried so the config is captured
 * once at startup instead of re-read per request.
 */
export function cliVersionMiddleware(
  config: Config,
): MiddlewareHandler<AppEnv> {
  const min = config.MIN_CLI_VERSION;
  // Fast-path: with MIN_CLI_VERSION at its 0.0.0 default, no header could
  // ever be "lower" — skip all parsing on every request.
  const enforcing = min !== "0.0.0";

  return async (c, next) => {
    if (!enforcing) return next();

    const header = c.req.header("x-pane-cli-version");
    // Header absent → library/non-CLI caller; never gated.
    if (header === undefined || header === "") return next();
    // Header present but not a clean semver → treat as missing. We don't
    // 400 on a malformed version because the relay's job here is to
    // protect against version skew, not to police header hygiene.
    if (!SEMVER_RE.test(header)) return next();

    if (compareSemver(header, min) < 0) {
      throw errors.cliUpgradeRequired(min, header);
    }
    return next();
  };
}
