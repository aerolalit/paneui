// Blob capability-URL tokens.
//
// A blob token authorises one or more GETs against `/b/<token>` without an
// agent API key. The token is high-entropy (192 bits), stored only as a
// sha256 hash (never the raw string), and bound to a TTL set at mint time
// per the scope of its parent blob.
//
// Wire format: `paneb_<base64url-of-24-random-bytes>` — 24 bytes is 192
// bits, matching the existing participant-token entropy in this codebase.
// The `paneb_` prefix lets log redaction and access-log scrubbing match
// blob tokens by shape alone.

import { createHash, randomBytes } from "node:crypto";

const PREFIX = "paneb_";

/**
 * Generate a fresh capability-URL token. Returns the raw token (what goes
 * into the URL), its sha256 hash (what gets stored), and a short prefix
 * (kept for log/UX correlation — never the full token).
 */
export function generateBlobToken(): {
  token: string;
  hash: string;
  prefix: string;
} {
  const random = randomBytes(24).toString("base64url");
  const token = `${PREFIX}${random}`;
  const hash = hashBlobToken(token);
  // First 10 chars = `paneb_` + 4 more — enough to disambiguate audit logs
  // without ever leaking enough to reuse.
  const prefix = token.slice(0, 10);
  return { token, hash, prefix };
}

/** sha256(token) hex — the storage form. */
export function hashBlobToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Cheap shape check before a DB lookup. Anything that doesn't start with
 * `paneb_` or doesn't decode to 24 base64url bytes is rejected here so we
 * don't waste a DB round-trip on obvious garbage.
 */
export function looksLikeBlobToken(s: string): boolean {
  if (!s.startsWith(PREFIX)) return false;
  const body = s.slice(PREFIX.length);
  // base64url(24 bytes) = 32 chars (no padding).
  if (body.length !== 32) return false;
  return /^[A-Za-z0-9_-]+$/.test(body);
}
