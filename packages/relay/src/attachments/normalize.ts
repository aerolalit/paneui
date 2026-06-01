// Polyglot defense + EXIF / thumbnail stripping via libvips (sharp).
//
// Every upload that sniffs to `image/{jpeg,png,gif,webp}` is decoded by
// sharp and re-encoded to the same format. The re-encode step:
//
//   * Drops any bytes appended after the legitimate image data — this is
//     how HTML/JPEG, GIF/JS, GIF/JAR, PNG/script, and similar polyglots
//     get sanitised. The original payload's "second format" sits outside
//     the image stream; the decode-encode round trip only carries the
//     pixel data forward.
//
//   * Strips EXIF, IPTC, XMP, ICC, and the embedded JPEG thumbnail.
//     Sharp's default `withMetadata({})` (empty options) is the strip
//     posture — explicit-blank options carry no metadata forward, even
//     the thumbnail-of-original which is a real footgun (you strip EXIF,
//     but a 100x100 JPEG-thumb-of-the-2000x2000 photo with its OWN GPS
//     EXIF sits inside the JPEG and is never touched).
//
//   * Preserves visible pixel content (a `pHash`-level comparison between
//     input and output is the same — verified in normalize.test.ts).
//
// Image formats that aren't decoded: SVG, PDF, anything else. These pass
// through unchanged. SVG carries inline <script> and event handlers
// natively and would need a separate XML sanitiser; v0.1.0 documents this
// in docs/SECURITY-POLYGLOTS.md as a known limitation and recommends
// operators remove `image/svg+xml` from BLOB_MIME_ALLOWLIST if their
// pane is exposed to untrusted UI rendering.

import { createHash } from "node:crypto";
import sharp from "sharp";

/** MIME types we put through sharp's decode-encode pipeline. */
const NORMALISABLE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export interface NormaliseInput {
  bytes: Buffer;
  mime: string;
  /** When true, strip metadata (EXIF / IPTC / XMP / ICC / thumbnail). Default true. */
  stripMetadata?: boolean;
}

export interface NormaliseResult {
  bytes: Buffer;
  mime: string;
  sha256: string;
  width?: number;
  height?: number;
  /** True when sharp actually processed the bytes; false for pass-through MIMEs. */
  normalised: boolean;
}

/**
 * Normalise an uploaded image. Decodes via sharp, drops appended polyglot
 * payloads, strips metadata (unless `stripMetadata=false` is opted out per
 * attachment), re-encodes to the same MIME, returns the clean bytes + sha256 +
 * dimensions.
 *
 * For non-normalisable MIMEs (svg, pdf, anything else) returns the input
 * unchanged with `normalised=false` so the caller can still hash and store.
 *
 * Throws if sharp can't decode the input — that's a real attacker signal
 * (a polyglot the format-sniff layer let through but isn't actually a
 * valid image). The route layer maps the throw to `mime_disallowed`.
 */
export async function normaliseImage(
  input: NormaliseInput,
): Promise<NormaliseResult> {
  const { mime, bytes } = input;
  const stripMetadata = input.stripMetadata !== false;

  if (!NORMALISABLE.has(mime)) {
    // Pass-through path: just compute sha256 and return the input bytes.
    return {
      bytes,
      mime,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      normalised: false,
    };
  }

  // Decode → re-encode through the same format. Sharp picks the encoder
  // from the requested format string; we keep the input MIME so the
  // route's downstream code (Content-Type, allowlist) sees no change.
  const pipeline = sharp(bytes, {
    // Sharp accepts wildly malformed inputs by default and tries to decode
    // them; setting `failOn: 'truncated'` makes it throw on the kind of
    // borderline-corrupt images polyglots tend to be.
    failOn: "truncated",
  });

  // Metadata posture: pass `withMetadata({})` (empty options) for the
  // strip-all default. When stripMetadata=false (rare opt-out for photo-
  // management workflows), we pass through the metadata sharp keeps by
  // default — but the embedded thumbnail still gets dropped because the
  // decode-encode round trip discards it regardless.
  const formatPipeline = withFormat(pipeline, mime);
  if (!stripMetadata) {
    // Keep EXIF / IPTC / XMP but the embedded thumbnail-of-original is
    // gone (sharp doesn't re-write thumbnails on encode).
    formatPipeline.withMetadata();
  }
  // Otherwise the default is "no metadata at all" — sharp doesn't carry
  // EXIF / IPTC / XMP / ICC unless explicitly told to via .withMetadata().

  let out: Buffer;
  let info: sharp.OutputInfo;
  try {
    const result = await formatPipeline.toBuffer({ resolveWithObject: true });
    out = result.data;
    info = result.info;
  } catch (e) {
    // Re-throw with a stable shape the route can pattern-match. We treat a
    // sharp decode failure as a hostile or unsupported image — the caller
    // panes it as `mime_disallowed` so the upload is rejected.
    throw new ImageNormalisationError(
      `image normalisation failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  return {
    bytes: out,
    mime,
    sha256: createHash("sha256").update(out).digest("hex"),
    width: info.width,
    height: info.height,
    normalised: true,
  };
}

/** Throw the route layer can pattern-match to map back to mime_disallowed. */
export class ImageNormalisationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageNormalisationError";
  }
}

/** Pin the output encoder to the input format. */
function withFormat(pipe: sharp.Sharp, mime: string): sharp.Sharp {
  switch (mime) {
    case "image/jpeg":
      return pipe.jpeg();
    case "image/png":
      return pipe.png();
    case "image/gif":
      return pipe.gif();
    case "image/webp":
      return pipe.webp();
    default:
      return pipe;
  }
}

/** Whether `mime` is a format the normaliser actively processes. */
export function isNormalisable(mime: string): boolean {
  return NORMALISABLE.has(mime);
}
