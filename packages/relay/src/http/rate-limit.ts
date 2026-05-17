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
import type { IncomingMessage } from "node:http";
import type { AppEnv } from "./env.js";
import { errors } from "./errors.js";

/**
 * Core trusted-proxy IP resolution, shared by the Hono `clientIp()` and the
 * raw-socket WebSocket-upgrade path. Given the socket peer address and the
 * raw `X-Forwarded-For` header value, returns the IP to bucket on.
 *
 * XFF is honored ONLY when the socket peer is a configured trusted proxy;
 * otherwise it is ignored and the socket address is used, so a direct client
 * cannot spoof its bucket. See `clientIp()` for the full rationale.
 */
function resolveClientIp(
  socketAddr: string | null,
  xff: string | undefined,
  trusted: readonly string[],
): string {
  if (xff && socketAddr && trusted.includes(socketAddr)) {
    const hops = xff
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    // Walk from the right (closest to our edge); the first hop that is not
    // itself a trusted proxy is the real client as our outermost proxy saw it.
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i]!;
      if (!trusted.includes(hop)) return hop;
    }
    // Whole chain was trusted proxies — fall through to the socket address.
  }
  return socketAddr ?? "unknown";
}

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
 * `trustedProxies` is passed in by the caller — the relay's `TRUSTED_PROXY`
 * config list, threaded through dependency injection (there is no config
 * singleton to read). Callers on the Hono request path source it from
 * `c.get("config").TRUSTED_PROXY`; unit tests pass a list directly.
 */
export function clientIp(
  c: Context,
  trustedProxies: readonly string[],
): string {
  let socketAddr: string | null = null;
  try {
    socketAddr = getConnInfo(c).remote.address ?? null;
  } catch {
    socketAddr = null;
  }
  return resolveClientIp(
    socketAddr,
    c.req.header("x-forwarded-for"),
    trustedProxies,
  );
}

export interface SlidingWindowLimiter {
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

/**
 * Enforce the per-IP registration rate limit. Throws ApiError(429) when the
 * caller's IP has exceeded the configured limit within the window. The limiter
 * itself is created once per app in buildApp() and read off the request
 * context, so its sliding-window state is shared across requests.
 */
export function enforceRegisterRateLimit(c: Context<AppEnv>): void {
  const ip = clientIp(c, c.get("config").TRUSTED_PROXY);
  if (!c.get("registerLimiter").check(ip)) {
    throw errors.tooManyRequests("registration rate limit exceeded");
  }
}

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
 *
 * The general limiter is created once per app in buildApp() from the injected
 * config and placed on the request context, so its sliding-window state is
 * shared across requests — and, critically, with the WebSocket-upgrade path,
 * which is handed the SAME limiter instance via `attachWs()`.
 */
export const generalRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const generalLimiter = c.get("generalLimiter");
  const ip = clientIp(c, c.get("config").TRUSTED_PROXY);
  if (!generalLimiter.check("ip:" + ip)) {
    throw errors.tooManyRequests("rate limit exceeded");
  }
  const tok = tokenKey(c);
  if (tok && !generalLimiter.check(tok)) {
    throw errors.tooManyRequests("rate limit exceeded");
  }
  await next();
};

/**
 * Per-IP rate limit for the WebSocket upgrade (`WS /v1/sessions/:id/stream`).
 *
 * The upgrade is handled out-of-band by the `server.on("upgrade")` listener,
 * NOT through the Hono app — so `generalRateLimit` middleware never runs for
 * it. Without this an attacker could hammer the upgrade endpoint (each upgrade
 * does a token resolve + DB lookups) with no per-IP bound, sidestepping the
 * per-session connection cap by rotating session ids / spraying invalid
 * tokens. Call this FIRST in the upgrade handler, before any DB work.
 *
 * The caller passes the SAME `generalLimiter` instance the Hono app uses (the
 * one buildApp() created from config) and the SAME `"ip:"` key, so a client's
 * WS-upgrade attempts and HTTP requests share one IP bucket. `trustedProxies`
 * is the injected `TRUSTED_PROXY` config list. Both are threaded in via
 * `attachWs()`'s deps — there is no module-level limiter or config singleton.
 *
 * Returns true if allowed, false if the IP has exceeded the limit. The caller
 * is a raw socket (pre-upgrade), so there is no `ApiError` to throw — the
 * handler responds with a bare HTTP 429.
 */
export function checkWsUpgradeRateLimit(
  req: IncomingMessage,
  generalLimiter: SlidingWindowLimiter,
  trustedProxies: readonly string[],
): boolean {
  const socketAddr = req.socket.remoteAddress ?? null;
  const xffRaw = req.headers["x-forwarded-for"];
  // node:http gives x-forwarded-for as string | string[]; normalise to one
  // comma-joined string for the shared resolver.
  const xff = Array.isArray(xffRaw) ? xffRaw.join(",") : xffRaw;
  const ip = resolveClientIp(socketAddr, xff, trustedProxies);
  return generalLimiter.check("ip:" + ip);
}
