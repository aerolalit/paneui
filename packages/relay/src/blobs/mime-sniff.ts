// Server-side MIME sniffing — magic-byte based, no library dependency.
//
// The relay NEVER trusts the client's Content-Type. The route layer always
// re-checks the actual leading bytes against this table; a mismatch returns
// 415 mime_mismatch. This is the first line of defence against "HTML labelled
// as image/jpeg" attacks before the polyglot normalisation pass (PR #5).
//
// v0.1.0 covers the MIME types in the default BLOB_MIME_ALLOWLIST:
// image/jpeg, image/png, image/gif, image/webp, image/svg+xml,
// application/pdf. Other types fall back to `application/octet-stream` and
// will fail the allowlist by default — operators add prefixes to
// BLOB_MIME_ALLOWLIST if they need them, then add sniff rules here.

/**
 * Best-guess MIME type for `buf` based on its leading bytes. Returns the
 * sniffed MIME, or `application/octet-stream` if no rule matched.
 *
 * Callers pass the first ~64 bytes of the upload; every rule below decides
 * inside that window. If a future format needs more bytes, raise the caller's
 * read-ahead (don't read more bytes per-call — that's a DoS vector).
 */
export function sniffMime(buf: Uint8Array): string {
  // JPEG: starts with the SOI marker `FF D8 FF`.
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return "image/jpeg";
  }

  // PNG: 8-byte signature `89 50 4E 47 0D 0A 1A 0A`.
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF: "GIF87a" or "GIF89a".
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46
  ) {
    return "image/gif";
  }

  // WebP: RIFF container `52 49 46 46 ?? ?? ?? ??` followed by `57 45 42 50`.
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }

  // WAV: RIFF container `52 49 46 46 ?? ?? ?? ??` followed by `57 41 56 45`.
  // Same family as WebP — just the trailing 4 bytes differ.
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x41 &&
    buf[10] === 0x56 &&
    buf[11] === 0x45
  ) {
    return "audio/wav";
  }

  // MP3: either an ID3v2 tag (`49 44 33`) or a frame sync (`FF Fb` / `FF F3` /
  // `FF F2` for MPEG audio layer III). The frame-sync variant covers files
  // without an ID3 header — common for short streamed clips.
  if (
    buf.length >= 3 &&
    buf[0] === 0x49 &&
    buf[1] === 0x44 &&
    buf[2] === 0x33
  ) {
    return "audio/mpeg";
  }
  if (
    buf.length >= 2 &&
    buf[0] === 0xff &&
    (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)
  ) {
    return "audio/mpeg";
  }

  // Ogg (Vorbis / Opus): signature `4F 67 67 53` ("OggS"). Disambiguating
  // Vorbis vs Opus needs the page header further in — return the umbrella
  // audio/ogg here and let the allowlist gate on `audio/` prefix.
  if (
    buf.length >= 4 &&
    buf[0] === 0x4f &&
    buf[1] === 0x67 &&
    buf[2] === 0x67 &&
    buf[3] === 0x53
  ) {
    return "audio/ogg";
  }

  // PDF: "%PDF-".
  if (
    buf.length >= 5 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46 &&
    buf[4] === 0x2d
  ) {
    return "application/pdf";
  }

  // SVG: textual, look for "<svg" within the first 64 bytes after skipping
  // optional BOM / XML declaration whitespace. Use a string scan rather than
  // a byte sequence so case + attribute order don't trip us up.
  if (looksLikeSvg(buf)) {
    return "image/svg+xml";
  }

  return "application/octet-stream";
}

/**
 * Cheap SVG check — looks for "<svg" within the leading bytes after
 * skipping whitespace + an optional XML declaration. We tolerate a BOM and
 * `<?xml ... ?>` because real SVG files in the wild include both.
 *
 * Lossless: false positives on HTML files with literal `<svg` strings are
 * fine — they get caught by the polyglot normalisation pass and would fail
 * the allowlist check at the route layer anyway.
 */
function looksLikeSvg(buf: Uint8Array): boolean {
  // Decode just the first 64 bytes as latin1 (every ASCII char maps 1:1).
  // Don't decode as utf8 — a malformed multi-byte sequence would throw, and
  // we only care about ASCII tag bytes here.
  const head = Array.from(buf.slice(0, 64))
    .map((b) => String.fromCharCode(b))
    .join("")
    .toLowerCase();

  // Strip optional UTF-8 BOM (EF BB BF → three latin1 chars).
  let s = head.replace(/^\xef\xbb\xbf/, "").trimStart();
  // Strip an XML declaration if present.
  if (s.startsWith("<?xml")) {
    const end = s.indexOf("?>");
    if (end < 0) return false; // declaration didn't close in our 64-byte window
    s = s.slice(end + 2).trimStart();
  }
  return s.startsWith("<svg");
}

/**
 * Return true if `mime` matches any prefix in the allowlist. An empty
 * allowlist (operator opt-out) accepts every sniffed MIME.
 */
export function isMimeAllowed(mime: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((prefix) => mime.startsWith(prefix));
}
