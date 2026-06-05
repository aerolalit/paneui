// Login cookie: opaque random token, server-issued, server-validated by
// looking up sha256(cookie) in the `logins` table. The cookie value is
// generated like other pane tokens (`lg_<base64url>`); the relay stores
// only the hash, mirroring how agent API keys and participant tokens
// are handled.
//
// Cookie attributes (set on the Set-Cookie header):
//   - HttpOnly       — JS in the iframe / shell never sees the value.
//   - SameSite=Lax   — cross-site form posts can't be authenticated by
//                       this cookie, but top-level navigations (the magic
//                       link click that lands on /auth/verify) carry it.
//   - Secure          — in production only. localhost http: dev would
//                       silently lose the cookie otherwise.
//   - Path=/          — the cookie scopes to the entire relay; both the
//                       /v1/api routes and the /home template pane
//                       (Phase D) use it.
//   - Max-Age         — LOGIN_TTL_SECONDS from config.

import { randomBytes } from "node:crypto";
import { hashKey } from "../keys.js";

export const LOGIN_COOKIE_NAME = "pane_login";
const LOGIN_PREFIX = "lg_";

// Pre-login nonce cookie (F-16 — login-CSRF / session-fixation defence).
// Set at request-link time, read + cleared at verify time. Scoped to the
// /v1/auth path so it never travels with ordinary API/pane requests.
export const ML_NONCE_COOKIE_NAME = "pane_ml_nonce";
const ML_NONCE_COOKIE_PATH = "/v1/auth";

export function generateLoginCookie(): string {
  return LOGIN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashLoginCookie(cookie: string): string {
  return hashKey(cookie);
}

export function buildSetCookieHeader(args: {
  value: string;
  maxAgeSeconds: number;
  isProduction: boolean;
}): string {
  const parts = [
    `${LOGIN_COOKIE_NAME}=${args.value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${args.maxAgeSeconds}`,
  ];
  if (args.isProduction) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookieHeader(args: {
  isProduction: boolean;
}): string {
  const parts = [
    `${LOGIN_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ];
  if (args.isProduction) parts.push("Secure");
  return parts.join("; ");
}

/** Parse Cookie header → record. Returns undefined for the named cookie if
 * missing. Tolerates whitespace and absent quoting. */
export function parseLoginCookie(cookieHeader: string | null): string | null {
  return parseCookieValue(cookieHeader, LOGIN_COOKIE_NAME);
}

/**
 * Set-Cookie for the pre-login nonce (F-16). Attributes:
 *   - HttpOnly       — the value never needs to be read by JS; keeping it
 *                       off the DOM removes an XSS exfil path.
 *   - SameSite=Lax   — the magic link is a top-level GET navigation from the
 *                       email client, which is cross-site relative to the
 *                       relay. SameSite=Strict cookies are NOT sent on a
 *                       cross-site top-level navigation, so Strict would drop
 *                       the nonce on exactly the request we need it on; Lax
 *                       IS sent for top-level GETs, so it's the correct (and
 *                       tightest workable) choice here.
 *   - Secure          — production only; localhost http: dev would otherwise
 *                       silently drop the cookie.
 *   - Path=/v1/auth   — scoped to the auth routes; not attached to API/pane
 *                       traffic.
 *   - Max-Age         — the magic-link TTL, so a stale nonce can't outlive the
 *                       link it binds.
 */
export function buildMagicLinkNonceCookieHeader(args: {
  value: string;
  maxAgeSeconds: number;
  isProduction: boolean;
}): string {
  const parts = [
    `${ML_NONCE_COOKIE_NAME}=${args.value}`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${ML_NONCE_COOKIE_PATH}`,
    `Max-Age=${args.maxAgeSeconds}`,
  ];
  if (args.isProduction) parts.push("Secure");
  return parts.join("; ");
}

/** Clear the pre-login nonce cookie (matching path so the browser drops it). */
export function buildClearMagicLinkNonceCookieHeader(args: {
  isProduction: boolean;
}): string {
  const parts = [
    `${ML_NONCE_COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${ML_NONCE_COOKIE_PATH}`,
    "Max-Age=0",
  ];
  if (args.isProduction) parts.push("Secure");
  return parts.join("; ");
}

/** Parse the pre-login nonce cookie from a Cookie header. */
export function parseMagicLinkNonceCookie(
  cookieHeader: string | null,
): string | null {
  return parseCookieValue(cookieHeader, ML_NONCE_COOKIE_NAME);
}

/** Read a single named cookie value from a Cookie header. Returns null if
 * absent. Tolerates whitespace and absent quoting. */
function parseCookieValue(
  cookieHeader: string | null,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    if (k === name) {
      return p.slice(eq + 1).trim() || null;
    }
  }
  return null;
}
