// In-memory sliding-window rate limiter, keyed by client IP.
//
// Used to bound abuse of the open POST /v1/register endpoint. No external
// dependency: state is a plain Map of IP -> recent request timestamps (ms).
//
// NOTE: this is single-process only. Each relay instance keeps its own map,
// so behind a multi-process / multi-instance deployment the effective limit
// is (limit * instances). A shared store (e.g. Redis) would be needed for a
// strict global limit. For Pane's current single-process relay this is fine.

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import config from "../config.js";
import { errors } from "./errors.js";

/**
 * Resolve the client IP for a request.
 *
 * The relay sits behind a proxy on Azure, so honor `x-forwarded-for` (taking
 * the first hop — the original client) when present. Otherwise fall back to
 * the raw connection's remote address. Returns "unknown" if neither is
 * available, which buckets all such requests together (fail-closed-ish).
 */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  // getConnInfo reads the Node socket off c.env; under app.fetch() (tests,
  // edge runtimes) there is no socket — fall back to "unknown" rather than
  // throwing. In that case all such requests share one bucket.
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

interface SlidingWindowLimiter {
  /** Returns true if the request is allowed, false if it exceeds the limit. */
  check(ip: string): boolean;
}

/**
 * Create a sliding-window limiter allowing `limit` requests per `windowMs`
 * per key. `limit <= 0` disables the limiter (every check passes).
 */
export function createRateLimiter(limit: number, windowMs: number): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();

  // Drop timestamps older than the window for a single key; delete the key
  // entirely if nothing recent remains, so the map can't grow unbounded.
  function prune(ip: string, now: number): number[] {
    const cutoff = now - windowMs;
    const recent = (hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (recent.length === 0) hits.delete(ip);
    else hits.set(ip, recent);
    return recent;
  }

  return {
    check(ip: string): boolean {
      if (limit <= 0) return true; // disabled
      const now = Date.now();

      // Opportunistic global sweep: prune every key occasionally so idle IPs
      // don't linger forever. Cheap because the map is small in practice.
      if (hits.size > 0 && Math.random() < 0.05) {
        for (const key of [...hits.keys()]) prune(key, now);
      }

      const recent = prune(ip, now);
      if (recent.length >= limit) return false;
      recent.push(now);
      hits.set(ip, recent);
      return true;
    },
  };
}

// Singleton limiter for the registration endpoint, configured from env.
const registerLimiter = createRateLimiter(
  config.REGISTER_RATE_LIMIT,
  config.REGISTER_RATE_WINDOW_SECONDS * 1000,
);

/**
 * Enforce the per-IP registration rate limit. Throws ApiError(429) when the
 * caller's IP has exceeded the configured limit within the window.
 */
export function enforceRegisterRateLimit(c: Context): void {
  if (!registerLimiter.check(clientIp(c))) {
    throw errors.tooManyRequests("registration rate limit exceeded");
  }
}
