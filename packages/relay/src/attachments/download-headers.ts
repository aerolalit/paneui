// Shared hardened response headers for every path that streams attachment /
// icon bytes back to a browser. Centralised so the agent download
// (GET /v1/attachments/:id), the capability-URL fetch (GET /b/:token), the
// participant download (GET /s/:token/attachments/:id) and the icon routes
// (GET /templates/:id/icon, /panes/:id/icon) can never drift on their
// security posture.
//
// Why these headers (see docs/CAPABILITY-URLS.md + docs/SECURITY-POLYGLOTS.md):
//
//   * Content-Disposition: `inline` ONLY for known-safe RASTER image types
//     (png/jpeg/webp/gif). EVERYTHING else — crucially `image/svg+xml`, which
//     is not normalised and can carry inline <script>/onload, but also PDF and
//     any other type — is served `attachment` so the browser downloads it
//     instead of rendering it in the relay origin. The decision uses the
//     raster set from @paneui/core, NOT a `startsWith("image/")` prefix (the
//     prefix matched svg; PDF was already served `attachment` under the old
//     prefix logic and stays that way).
//   * Content-Security-Policy: `default-src 'none'; sandbox` neutralises any
//     active content if the bytes are somehow rendered as a document
//     (sandbox with no allow-tokens disables scripts, forms, same-origin,
//     popups, etc.); `frame-ancestors 'none'` blocks framing.
//   * X-Frame-Options: DENY — belt-and-braces framing block for older
//     browsers that don't honour frame-ancestors.
//   * X-Content-Type-Options: nosniff, Cross-Origin-Resource-Policy:
//     same-origin, Referrer-Policy: no-referrer — unchanged from before.

import type { Context } from "hono";
import { isRasterImageMime } from "@paneui/core";

// CSP applied to every attachment / icon byte response. `default-src 'none'`
// + `sandbox` (no allow-tokens → all capabilities disabled) defangs any
// document that does get rendered; `frame-ancestors 'none'` blocks framing
// (closes the same-site framing gap CORP alone leaves — #202). Built from an
// array so a directive can be added in exactly one place.
export const BLOB_CSP = [
  "default-src 'none'",
  "sandbox",
  "frame-ancestors 'none'",
].join("; ");

// MIME types served `Content-Disposition: inline`. Only known-safe RASTER
// images (png/jpeg/webp/gif) render inline — they are normalised through sharp
// and carry no active content. Everything else — svg (script vector), pdf,
// html, anything — is forced to `attachment` so it downloads rather than
// rendering in the relay origin.
export function isInlineDisposableMime(mime: string): boolean {
  return isRasterImageMime(mime);
}

/** `inline` for raster images, `attachment` for everything else (incl. svg, pdf). */
export function dispositionFor(mime: string): "inline" | "attachment" {
  return isInlineDisposableMime(mime) ? "inline" : "attachment";
}

/**
 * Set the CSP + X-Frame-Options framing defences shared by EVERY attachment /
 * icon byte response. Kept separate from the disposition/cache headers so the
 * icon routes (which use their own Cache-Control + ETag + always-inline raster
 * disposition) can reuse just the framing defences.
 */
export function setBlobFramingHeaders(c: Context): void {
  c.header("Content-Security-Policy", BLOB_CSP);
  c.header("X-Frame-Options", "DENY");
}

/**
 * Apply the full hardened header set for an agent / participant / capability
 * attachment download: Content-Type, Content-Length (PLAINTEXT size),
 * nosniff, raster-only inline disposition, no-store caching, same-origin CORP,
 * no-referrer, and the framing defences (CSP + X-Frame-Options).
 *
 * Callers that need different caching (the icon routes — cacheable, ETag'd)
 * set their own Content-Type/Cache-Control and call setBlobFramingHeaders()
 * directly instead.
 */
export function setAttachmentDownloadHeaders(
  c: Context,
  opts: { mime: string; size: number },
): void {
  c.header("Content-Type", opts.mime);
  c.header("Content-Length", String(opts.size));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Disposition", dispositionFor(opts.mime));
  c.header("Cache-Control", "private, no-store");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Referrer-Policy", "no-referrer");
  setBlobFramingHeaders(c);
}
