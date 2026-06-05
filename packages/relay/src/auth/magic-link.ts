// Magic-link tokens: generation, hashing, redemption.
//
// Token shape: `ml_<32-base64url>`. Stored as sha256(token) in the
// `magic_links` table; the raw value lives only in the email link until
// it is consumed.

import { randomBytes } from "node:crypto";
import { hashKey } from "../keys.js";

const MAGIC_LINK_PREFIX = "ml_";
const MAGIC_LINK_NONCE_PREFIX = "mln_";

export function generateMagicLinkToken(): string {
  return MAGIC_LINK_PREFIX + randomBytes(32).toString("base64url");
}

export function hashMagicLinkToken(token: string): string {
  return hashKey(token);
}

/**
 * Pre-login nonce that binds a magic link to the browser that requested it
 * (login-CSRF / session-fixation defence, F-16). The raw value is set as a
 * short-lived cookie in the requester's browser at request-link time; only
 * its hash is stored on the MagicLink row. At verify time the cookie's hash
 * must match the stored hash, so a link minted for an attacker's account
 * can't log a victim's browser in — the victim never holds the matching
 * nonce cookie. Same shape/strength as the token: 32 random bytes, prefixed.
 */
export function generateMagicLinkNonce(): string {
  return MAGIC_LINK_NONCE_PREFIX + randomBytes(32).toString("base64url");
}

export function hashMagicLinkNonce(nonce: string): string {
  return hashKey(nonce);
}

/**
 * Build the absolute magic-link URL the recipient clicks. The token is in
 * the query string (not the path) so existing web-server access logs that
 * redact `?...` already protect it.
 *
 * Path matches the actual route mount: src/http/routes/auth.ts is mounted
 * at /v1 in app.ts, with route `/auth/verify` → final path `/v1/auth/verify`.
 */
export function buildMagicLinkUrl(args: {
  publicUrl: string;
  token: string;
}): string {
  const base = args.publicUrl.replace(/\/$/, "");
  const t = encodeURIComponent(args.token);
  return `${base}/v1/auth/verify?token=${t}`;
}

/**
 * Normalise an email address to a lower-case, trimmed form. Magic links are
 * sent to whatever the caller submitted; the Human row's `email` column is
 * unique on the normalised form so address-case variants don't fork accounts.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
