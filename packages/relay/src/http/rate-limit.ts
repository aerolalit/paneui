// In-memory sliding-window rate limiter, keyed by client IP (and optionally
// token).
//
// Used to bound abuse of the open POST /v1/register endpoint and every other
// /v1 + /s route. No external dependency: state is a plain Map of key ->
// recent request timestamps (ms).
//
// NOTE: this is single-process only. Each relay instance keeps its own map,
// so behind a multi-process / multi-instance deployment the effective limit
// is (limit * instances). A shared store (e.g. Redis) would be needed for a
// strict global limit. For Pane's current single-process relay this is fine.

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import config from "../config.js";
import { errors } from "./errors.js";

/**
 * Resolve the client IP for a request.
 *
 * `X-Forwarded-For` is attacker-controlled: any direct client can set it to
 * an arbitrary value. We therefore only honor it when the socket peer (the
 * machine that actually opened the TCP connection) is a configured
 * `TRUSTED_PROXY`. In that case the XFF chain looks like
 * `client, proxy1, proxy2, ...` and we take the *last untrusted hop* — the
 * right-most entry that is not itself one of our trusted proxies — which is
 * the closest address our trusted edge actually observed.
 *
 * When the socket peer is NOT a trusted proxy (a direct client), XFF is
 * ignored entirely and the raw socket address is used, so a spoofed header
 * cannot move the caller into a different rate-limit bucket.
 *
 * Returns "unknown" if no address is available (e.g. under app.fetch() in
 * tests, where there is no socket), which buckets all such requests together.
 *
 * `trustedProxies` defaults to the configured `TRUSTED_PROXY` list; it is a
 * parameter purely so unit tests can exercise the trust logic directly.
 */
export function clientIp(
  c: Context,
  trustedProxies: readonly string[] = config.TRUSTED_PROXY,
): string {
  let socketAddr: string | null = null;
  try {
    socketAddr = getConnInfo(c).remote.address ?? null;
  } catch {
    socketAddr = null;
  }

  const xff = c.req.header("x-forwarded-for");
  const trusted = trustedProxies;

  // Honor XFF only when we can confirm the socket peer is a trusted proxy.
  if (xff && socketAddr && trusted.includes(socketAddr)) {
    const hops = xff
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    // Walk from the right (closest to our edge) and skip any hop that is
    // itself a trusted proxy. The first non-trusted hop is the real client
    // as seen by our outermost trusted proxy.
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i]!;
      if (!trusted.includes(hop)) return hop;
    }
    // Whole chain was trusted proxies — fall through to the socket address.
  }

  return socketAddr ?? "unknown";
}

interface SlidingWindowLimiter {
  /** Returns true if the request is allowed, false if it exceeds the limit. */
  check(key: string): boolean;
}

/**
 * Create a sliding-window limiter allowing `limit` requests per `windowMs`
 * per key. `limit <= 0` disables the limiter (every check passes).
 */
export function createRateLimiter(
  limit: number,
  windowMs: number,
): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();

  // Drop timestamps older than the window for a single key; delete the key
  // entirely if nothing recent remains, so the map can't grow unbounded.
  function prune(key: string, now: number): number[] {
    const cutoff = now - windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length === 0) hits.delete(key);
    else hits.set(key, recent);
    return recent;
  }

  return {
    check(key: string): boolean {
      if (limit <= 0) return true; // disabled
      const now = Date.now();

      // Opportunistic global sweep: prune every key occasionally so idle keys
      // don't linger forever. Cheap because the map is small in practice.
      if (hits.size > 0 && Math.random() < 0.05) {
        for (const k of [...hits.keys()]) prune(k, now);
      }

      const recent = prune(key, now);
      if (recent.length >= limit) return false;
      recent.push(now);
      hits.set(key, recent);
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

// General-purpose limiter covering every /v1 + /s route. Keyed per-IP, and —
// when the caller presents a bearer/participant token — additionally per
// token, so one IP rotating tokens (or one token roaming IPs) is still bound.
const generalLimiter = createRateLimiter(
  config.RATE_LIMIT,
  config.RATE_LIMIT_WINDOW_SECONDS * 1000,
);

/**
 * Extract a stable, low-cardinality token fingerprint from the Authorization
 * header for rate-limiting purposes. We never log or store the raw token —
 * a short prefix is enough to bucket a single credential.
 */
function tokenKey(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  return "tok:" + m[1]!.trim().slice(0, 16);
}

/**
 * Hono middleware enforcing the general per-IP + per-token rate limit. Applied
 * to all /v1/* and /s/* routes. Throws ApiError(429) when either the caller's
 * IP or its bearer token has exceeded the configured limit within the window.
 */
export const generalRateLimit: MiddlewareHandler = async (c, next) => {
  const ip = clientIp(c);
  if (!generalLimiter.check("ip:" + ip)) {
    throw errors.tooManyRequests("rate limit exceeded");
  }
  const tok = tokenKey(c);
  if (tok && !generalLimiter.check(tok)) {
    throw errors.tooManyRequests("rate limit exceeded");
  }
  await next();
};
