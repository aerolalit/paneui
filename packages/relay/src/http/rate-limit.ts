// Sliding-window rate limiter, keyed by client IP (and optionally token).
//
// Used to bound abuse of the open POST /v1/register endpoint and every other
// /v1 + /s route.
//
// Two backends, selected at runtime by `redisEnabled()`:
//
//   REDIS OFF (single replica / self-host) — an in-process Map of key ->
//   recent request timestamps (ms). No external dependency. Correct for a
//   single replica; behind multiple replicas the effective limit would be
//   (limit * replicas), which is why the Redis path exists.
//
//   REDIS ON (multi-replica) — a sorted set per key in Redis: ZADD the current
//   timestamp, ZREMRANGEBYSCORE to prune entries older than the window, ZCARD
//   to count what remains, and EXPIRE the key so idle keys are reclaimed. This
//   is the standard correct sliding window and gives ONE global limit shared
//   across every replica.
//
// `check()` is ASYNC in both modes — Redis makes it inherently async, and the
// in-process path simply resolves an already-computed boolean so callers have
// a single code path. See SlidingWindowLimiter below.

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { IncomingMessage } from "node:http";
import type { AppEnv } from "./env.js";
import { errors } from "./errors.js";
import { redisEnabled, redisPub } from "../redis.js";
import { log } from "../log.js";

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
  // `*` in TRUSTED_PROXY trusts X-Forwarded-For from any socket peer — for
  // deployments (e.g. Azure Container Apps) where the proxy's source IP is
  // not a stable literal. Otherwise the socket peer must be a listed IP.
  const trustAny = trusted.includes("*");
  if (xff && (trustAny || (socketAddr && trusted.includes(socketAddr)))) {
    const hops = xff
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    // Walk from the right (closest to our edge); the first hop that is not
    // itself a trusted proxy is the real client as our outermost proxy saw
    // it. With `*` no hop is "trusted", so this takes the right-most hop —
    // the client IP as the ingress recorded it.
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
 * The special `TRUSTED_PROXY` value `*` trusts XFF from any socket peer —
 * for proxies whose source IP is not a stable literal (e.g. Azure Container
 * Apps ingress). Safe only when the relay is unreachable except through
 * such a proxy; see the `TRUSTED_PROXY` config comment.
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
  let socketAddr: string | null;
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
  /**
   * Resolves true if the request is allowed, false if it exceeds the limit.
   *
   * Async in BOTH backends: the Redis sliding window is inherently async, and
   * the in-process path resolves an already-computed boolean (a near-free
   * microtask) so every caller has exactly one code path regardless of
   * whether Redis is configured.
   */
  check(key: string): Promise<boolean>;
}

/**
 * Create a sliding-window limiter allowing `limit` requests per `windowMs`
 * per key. `limit <= 0` disables the limiter (every check passes).
 *
 * The returned limiter picks its backend per call: when Redis is enabled it
 * uses a Redis sorted set (global limit across replicas); otherwise it uses
 * the in-process Map (single-replica behaviour, byte-for-byte as before).
 */
export function createRateLimiter(
  limit: number,
  windowMs: number,
): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();
  // A short, stable namespace so two limiter instances (register vs general)
  // never collide on the same Redis key.
  const ns = `pane:rl:${windowMs}:`;

  // Drop timestamps older than the window for a single key; delete the key
  // entirely if nothing recent remains, so the map can't grow unbounded.
  function prune(key: string, now: number): number[] {
    const cutoff = now - windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length === 0) hits.delete(key);
    else hits.set(key, recent);
    return recent;
  }

  // In-process sliding window — the original synchronous logic, wrapped in a
  // resolved Promise so the interface is uniform.
  function checkInProcess(key: string): boolean {
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
  }

  // Redis sliding window — sorted set per key. The four commands run in a
  // MULTI so the count-then-add is atomic against concurrent requests from
  // other replicas hitting the same key.
  async function checkRedis(key: string): Promise<boolean> {
    const now = Date.now();
    const cutoff = now - windowMs;
    const rkey = ns + key;
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const results = await redisPub()
      .multi()
      // Prune entries older than the window first.
      .zremrangebyscore(rkey, 0, cutoff)
      // Count what remains BEFORE adding this request.
      .zcard(rkey)
      // Record this request, scored by its timestamp.
      .zadd(rkey, now, member)
      // Reclaim the key once the whole window has gone idle.
      .pexpire(rkey, windowMs)
      .exec();
    // results[1] is the ZCARD reply: [err, count].
    const countReply = results?.[1];
    const priorCount =
      countReply && typeof countReply[1] === "number" ? countReply[1] : 0;
    return priorCount < limit;
  }

  return {
    async check(key: string): Promise<boolean> {
      if (limit <= 0) return true; // disabled
      if (!redisEnabled()) return checkInProcess(key);
      try {
        return await checkRedis(key);
      } catch (err) {
        // A mid-flight Redis failure must not 500 the request. Fall back to
        // the in-process limiter for this call — degraded (per-replica) but
        // still bounded — and log it.
        log.warn("rate-limit: redis check failed, using in-process fallback", {
          error: err instanceof Error ? err.message : String(err),
        });
        return checkInProcess(key);
      }
    },
  };
}

/**
 * Enforce the per-IP registration rate limit. Throws ApiError(429) when the
 * caller's IP has exceeded the configured limit within the window. The limiter
 * itself is created once per app in buildApp() and read off the request
 * context, so its sliding-window state is shared across requests.
 *
 * Async because the underlying limiter is async (Redis-backed when REDIS_URL
 * is set). The register route handler awaits this.
 */
export async function enforceRegisterRateLimit(
  c: Context<AppEnv>,
): Promise<void> {
  const ip = clientIp(c, c.get("config").TRUSTED_PROXY);
  if (!(await c.get("registerLimiter").check(ip))) {
    throw errors.tooManyRequests("registration rate limit exceeded");
  }
}

/**
 * Check the magic-link request-link rate limit, keyed on BOTH the client IP
 * and the normalized target email. Unlike enforceRegisterRateLimit this does
 * NOT throw on exhaustion — POST /v1/auth/request-link always returns 202 to
 * avoid an account-enumeration oracle, so the caller uses the boolean to skip
 * creating the MagicLink row / sending the email while still returning 202.
 *
 * Both keys must be under their limit for the request to be allowed; if either
 * is exhausted the request is throttled. The two keys are namespaced (`ip:` /
 * `ml:`) so they never collide with each other or with the general limiter's
 * `ip:` bucket (which lives in a different limiter instance / Redis namespace).
 *
 * Returns true if a link may be sent, false if the request should be silently
 * dropped (still 202 at the route).
 */
export async function checkMagicLinkRateLimit(
  c: Context<AppEnv>,
  email: string,
): Promise<boolean> {
  const limiter = c.get("magicLinkLimiter");
  const ip = clientIp(c, c.get("config").TRUSTED_PROXY);
  // Check the email key first so a rotating-IP attacker bombing one address is
  // throttled regardless of source IP, then the per-IP key. Both must pass.
  const emailOk = await limiter.check("ml:" + email);
  const ipOk = await limiter.check("ip:" + ip);
  return emailOk && ipOk;
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
  if (!(await generalLimiter.check("ip:" + ip))) {
    throw errors.tooManyRequests("rate limit exceeded");
  }
  const tok = tokenKey(c);
  if (tok && !(await generalLimiter.check(tok))) {
    throw errors.tooManyRequests("rate limit exceeded");
  }
  await next();
};

/**
 * Per-IP rate limit for the WebSocket upgrade (`WS /v1/panes/:id/stream`).
 *
 * The upgrade is handled out-of-band by the `server.on("upgrade")` listener,
 * NOT through the Hono app — so `generalRateLimit` middleware never runs for
 * it. Without this an attacker could hammer the upgrade endpoint (each upgrade
 * does a token resolve + DB lookups) with no per-IP bound, sidestepping the
 * per-pane connection cap by rotating pane ids / spraying invalid
 * tokens. Call this FIRST in the upgrade handler, before any DB work.
 *
 * The caller passes the SAME `generalLimiter` instance the Hono app uses (the
 * one buildApp() created from config) and the SAME `"ip:"` key, so a client's
 * WS-upgrade attempts and HTTP requests share one IP bucket. `trustedProxies`
 * is the injected `TRUSTED_PROXY` config list. Both are threaded in via
 * `attachWs()`'s deps — there is no module-level limiter or config singleton.
 *
 * Resolves true if allowed, false if the IP has exceeded the limit. The caller
 * is a raw socket (pre-upgrade), so there is no `ApiError` to throw — the
 * handler responds with a bare HTTP 429.
 *
 * Async because the underlying limiter is async (Redis-backed when REDIS_URL
 * is set). The upgrade handler already runs in an async context, so it awaits.
 */
export function checkWsUpgradeRateLimit(
  req: IncomingMessage,
  generalLimiter: SlidingWindowLimiter,
  trustedProxies: readonly string[],
): Promise<boolean> {
  const socketAddr = req.socket.remoteAddress ?? null;
  const xffRaw = req.headers["x-forwarded-for"];
  // node:http gives x-forwarded-for as string | string[]; normalise to one
  // comma-joined string for the shared resolver.
  const xff = Array.isArray(xffRaw) ? xffRaw.join(",") : xffRaw;
  const ip = resolveClientIp(socketAddr, xff, trustedProxies);
  return generalLimiter.check("ip:" + ip);
}
