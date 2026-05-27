// Magic-link tokens: generation, hashing, redemption.
//
// Token shape: `ml_<32-base64url>`. Stored as sha256(token) in the
// `magic_links` table; the raw value lives only in the email link until
// it is consumed.

import { randomBytes } from "node:crypto";
import { hashKey } from "../keys.js";

const MAGIC_LINK_PREFIX = "ml_";

export function generateMagicLinkToken(): string {
  return MAGIC_LINK_PREFIX + randomBytes(32).toString("base64url");
}

export function hashMagicLinkToken(token: string): string {
  return hashKey(token);
}

/**
 * Build the absolute magic-link URL the recipient clicks. The token is in
 * the query string (not the path) so existing web-server access logs that
 * redact `?...` already protect it.
 */
export function buildMagicLinkUrl(args: {
  publicUrl: string;
  token: string;
}): string {
  const base = args.publicUrl.replace(/\/$/, "");
  const t = encodeURIComponent(args.token);
  return `${base}/auth/verify?token=${t}`;
}

/**
 * Normalise an email address to a lower-case, trimmed form. Magic links are
 * sent to whatever the caller submitted; the Human row's `email` column is
 * unique on the normalised form so address-case variants don't fork accounts.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
