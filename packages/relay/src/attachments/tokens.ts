// Blob capability-URL tokens.
//
// A attachment token authorises one or more GETs against `/b/<token>` without an
// agent API key. The token is high-entropy (192 bits), stored only as a
// sha256 hash (never the raw string), and bound to a TTL set at mint time
// per the scope of its parent attachment.
//
// Wire format: `paneb_<base64url-of-24-random-bytes>` — 24 bytes is 192
// bits, matching the existing participant-token entropy in this codebase.
// The `paneb_` prefix lets log redaction and access-log scrubbing match
// attachment tokens by shape alone.

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

// Matches a well-formed attachment token wherever it sits inside a larger
// string — most often as the last path segment of a `/b/<token>` capability
// URL. The boundaries are deliberate:
//   - `(?<![A-Za-z0-9_-])` before the prefix rejects `xpaneb_…` (a `paneb_`
//     run glued onto preceding base64url bytes is not a clean token start).
//   - `{32}` pins the body to exactly 24 base64url-encoded bytes, the same
//     length `looksLikeBlobToken` enforces.
//   - `(?![A-Za-z0-9_-])` after the body rejects a 33rd base64url char, so a
//     longer random string can't be sliced down to a spurious 32-char "token".
const BLOB_TOKEN_RX =
  /(?<![A-Za-z0-9_-])paneb_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g;

/**
 * Walk any JSON-shaped value and pull out every attachment token embedded in a
 * string leaf — e.g. the `paneb_…` segment of a `/b/<token>` URL an agent baked
 * into a pane's `input_data`. Used by the pane-create token-TTL cascade (#501):
 * the relay re-mints/extends these so a capability URL doesn't 404 partway
 * through the life of a pane that outlives it.
 *
 * Scans raw string content (not the schema), so it catches tokens regardless of
 * where they sit — a bare URL, a markdown link, a CSS `url(...)`, an HTML
 * attribute. Tokens from another relay (or pure garbage) simply won't resolve
 * to a row in the caller's batched lookup, so over-collection is harmless.
 *
 * Returns deduped raw tokens in first-seen order. Guards against pathological
 * input with a node budget so a deeply nested or huge payload can't pin the
 * event loop; the cap is far above any real `input_data`.
 */
export function extractBlobTokens(value: unknown): string[] {
  const out = new Set<string>();
  // Bound the walk — `input_data` is already size-capped upstream, but the
  // walker shouldn't assume that and shouldn't recurse without a ceiling.
  let budget = 100_000;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    if (budget-- <= 0) break;
    const v = stack.pop();
    if (typeof v === "string") {
      const matches = v.match(BLOB_TOKEN_RX);
      if (matches) for (const m of matches) out.add(m);
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (v && typeof v === "object") {
      for (const item of Object.values(v)) stack.push(item);
    }
  }
  return Array.from(out);
}
