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
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    if (k === LOGIN_COOKIE_NAME) {
      return p.slice(eq + 1).trim() || null;
    }
  }
  return null;
}
