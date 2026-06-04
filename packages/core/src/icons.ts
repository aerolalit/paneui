// Icon helpers shared by the relay and CLI — emoji validation and the raster
// image MIME allowlist for template/pane icons.
//
// Icons are deliberately constrained: either ONE emoji grapheme (rendered
// inline as text) or an uploaded raster image (served from the relay's blob
// store). No external URLs, no SVG (XSS vector), no multi-character strings.

// Raster image MIME types accepted as an uploaded icon. SVG is deliberately
// EXCLUDED — it can carry script and is an XSS vector when rendered in an
// <img> from a same-origin route. Vector/animated-vector and non-image types
// are rejected.
export const RASTER_ICON_MIME_ALLOWLIST = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type RasterIconMime = (typeof RASTER_ICON_MIME_ALLOWLIST)[number];

/** True iff `mime` is a raster image type allowed as an icon. */
export function isRasterImageMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  // Normalise: drop any `; charset=...` parameter and lowercase.
  const base = mime.split(";")[0]!.trim().toLowerCase();
  return (RASTER_ICON_MIME_ALLOWLIST as readonly string[]).includes(base);
}

// Upper bound on the raw byte length of an emoji string. A single rendered
// emoji can be a long ZWJ sequence (e.g. a family/flag with skin-tone
// modifiers), but 64 bytes is well beyond any real single grapheme and bounds
// the work the segmenter does.
export const MAX_ICON_EMOJI_BYTES = 64;

// Matches a code point with the Extended_Pictographic property — the Unicode
// property that flags "this is an emoji-ish pictograph". Used to ensure the
// grapheme actually contains an emoji and isn't a plain letter/digit/symbol.
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

// Control characters (C0 + DEL + C1) are never valid in an icon emoji. The
// control chars in the class are intentional — that's exactly what we reject.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;

const byteLength = (s: string): number =>
  typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(s).length
    : Buffer.byteLength(s, "utf8");

/**
 * Validate an icon emoji. Returns `{ ok: true }` for a single emoji grapheme,
 * or `{ ok: false, error }` with a human-readable reason otherwise.
 *
 * Rules:
 *  - non-empty, ≤ MAX_ICON_EMOJI_BYTES bytes
 *  - no control characters
 *  - exactly ONE grapheme cluster (via Intl.Segmenter)
 *  - that grapheme contains at least one Extended_Pictographic code point
 *    (so plain ASCII letters/digits and bare symbols are rejected)
 */
export function validateIconEmoji(
  raw: string,
): { ok: true } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "icon_emoji must be a non-empty string" };
  }
  if (byteLength(raw) > MAX_ICON_EMOJI_BYTES) {
    return {
      ok: false,
      error: `icon_emoji must be at most ${MAX_ICON_EMOJI_BYTES} bytes`,
    };
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    return {
      ok: false,
      error: "icon_emoji must not contain control characters",
    };
  }

  // Count grapheme clusters. Intl.Segmenter is available in Node 20+ and all
  // evergreen browsers (our targets); guard defensively anyway.
  let graphemeCount: number;
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
    // Iterate the segmenter to count grapheme clusters. `[...iterable].length`
    // materialises the segments, but a single emoji is tiny so it's fine.
    graphemeCount = [...seg.segment(raw)].length;
  } else {
    // Fallback: count code points (over-counts ZWJ sequences, but the
    // pictographic check below still gates non-emoji input).
    graphemeCount = Array.from(raw).length;
  }

  if (graphemeCount !== 1) {
    return {
      ok: false,
      error: "icon_emoji must be exactly one emoji (a single grapheme)",
    };
  }

  if (!EXTENDED_PICTOGRAPHIC_RE.test(raw)) {
    return {
      ok: false,
      error: "icon_emoji must be an emoji, not a letter, digit, or symbol",
    };
  }

  return { ok: true };
}

/** Convenience boolean form of {@link validateIconEmoji}. */
export function isValidIconEmoji(raw: string): boolean {
  return validateIconEmoji(raw).ok;
}
