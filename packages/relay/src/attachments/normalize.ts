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
// SVG is a special case (F-13). SVG is XML and carries inline <script>,
// event-handler attributes (onload=...), <foreignObject>, and
// `javascript:`/external `href`/`xlink:href` references natively — none of
// which a byte-trimming pass would remove. It is rejected by the DEFAULT
// allowlist (see config.ts), but an operator can opt it back in via
// BLOB_MIME_ALLOWLIST. When they do and an SVG actually reaches this
// normaliser, we RASTERISE it to PNG via sharp (libvips → librsvg). The
// raster output is pure pixel data: every script, handler, foreignObject and
// external reference is dropped wholesale because none of it survives the
// vector→bitmap decode. The stored MIME therefore changes from
// `image/svg+xml` to `image/png` (the caller updates the row's mime/size/
// dimensions from the NormaliseResult accordingly) and the attachment joins
// the normalised raster set — so it is also eligible for inline disposition.
// See docs/SECURITY-POLYGLOTS.md.
//
// Image formats that aren't decoded: PDF, anything else. These pass through
// unchanged.

import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Decompression-bomb ceiling for the decode step.
 *
 * Input bytes are already capped at MAX_BLOB_BYTES (5 MB by default), but a
 * highly-compressed image inside that budget can declare enormous dimensions —
 * sharp's own default (~268 MP, ~1 GB of RGBA pixels) would still be honoured
 * and, under concurrency, several such decodes could exhaust memory. We pin a
 * far lower explicit ceiling: 50 MP comfortably covers any image a human would
 * realistically upload to a pane (a 50 MP photo is an ~8660×5773 frame) while
 * keeping per-decode peak memory bounded (~200 MB RGBA worst case).
 *
 * sharp checks this against the declared header dimensions *before* full
 * decode, so an over-limit image is rejected in ~constant time. The throw is
 * caught below and surfaced as an ImageNormalisationError → the route maps it
 * to a 415 (mime_disallowed), the same path a malformed image takes. A
 * per-process concurrency semaphore over normaliseImage() is a sensible future
 * hardening on top of this ceiling, but is out of scope here.
 */
export const MAX_IMAGE_PIXELS = 50_000_000;

/** MIME types we put through sharp's decode-encode pipeline. */
const NORMALISABLE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** SVG MIME. Handled by rasterisation (vector → PNG) rather than re-encode. */
const SVG_MIME = "image/svg+xml";

/**
 * F-17 — concurrency bound for sharp decodes.
 *
 * `limitInputPixels` (MAX_IMAGE_PIXELS) caps the peak memory of a SINGLE
 * decode, but says nothing about how many run at once. Under a burst of
 * simultaneous large-image uploads, N concurrent decodes can collectively
 * allocate N × (per-decode peak) and exhaust process memory. We bound the
 * number of in-flight sharp operations with a tiny in-process semaphore.
 *
 * 4 is deliberately small: it keeps the worst-case aggregate decode memory
 * to ~4 × 200 MB ≈ 800 MB (the MAX_IMAGE_PIXELS RGBA worst case) while still
 * allowing useful parallelism — uploads beyond the bound queue rather than
 * fail, and the wait is bounded by how fast a decode completes (tens of ms
 * for realistic images). It's a constant rather than an env knob because the
 * safe value is a function of MAX_IMAGE_PIXELS + host memory, not something an
 * operator should tune blindly; revisit alongside MAX_IMAGE_PIXELS if needed.
 */
const SHARP_MAX_CONCURRENCY = 4;

/**
 * Minimal FIFO counting semaphore. `acquire()` resolves immediately while
 * fewer than `max` permits are held, otherwise queues; `release()` hands the
 * permit to the next waiter (or returns it to the pool). No external dep —
 * the repo has no existing semaphore/queue util.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const sharpSemaphore = new Semaphore(SHARP_MAX_CONCURRENCY);

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
 * SVG is special: it is rasterised to PNG (vector → bitmap), which strips ALL
 * executable content (script / event handlers / foreignObject / external
 * refs). The returned `mime` is `image/png` (NOT the input `image/svg+xml`) —
 * the caller MUST persist `result.mime`/`result.size`/`result.width/height`,
 * not the sniffed values, so the stored row stays consistent.
 *
 * For non-normalisable MIMEs (pdf, anything else) returns the input unchanged
 * with `normalised=false` so the caller can still hash and store.
 *
 * Throws if sharp can't decode the input — that's a real attacker signal
 * (a polyglot the format-sniff layer let through but isn't actually a
 * valid image, or malformed SVG XML). The route layer maps the throw to
 * `mime_disallowed`.
 *
 * Concurrent calls are bounded by `sharpSemaphore` (F-17) so a burst of large
 * uploads can't collectively exhaust memory.
 */
export async function normaliseImage(
  input: NormaliseInput,
): Promise<NormaliseResult> {
  const { mime, bytes } = input;
  const stripMetadata = input.stripMetadata !== false;
  const isSvg = mime === SVG_MIME;

  if (!isSvg && !NORMALISABLE.has(mime)) {
    // Pass-through path: just compute sha256 and return the input bytes.
    return {
      bytes,
      mime,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      normalised: false,
    };
  }

  // The MIME of the encoded output. For raster inputs we keep the input
  // format; for SVG we rasterise to PNG.
  const outMime = isSvg ? "image/png" : mime;

  // Decode → re-encode. For raster the encoder matches the input format; for
  // SVG, sharp decodes the vector (via librsvg) and we encode PNG. Either way
  // the decode-encode round trip carries only pixel data forward, dropping
  // appended polyglot tails AND (for SVG) all script/handler/foreignObject
  // markup.
  const pipeline = sharp(bytes, {
    // Sharp accepts wildly malformed inputs by default and tries to decode
    // them; setting `failOn: 'truncated'` makes it throw on the kind of
    // borderline-corrupt images polyglots tend to be.
    failOn: "truncated",
    // Decompression-bomb ceiling — see MAX_IMAGE_PIXELS. Checked against the
    // declared header dimensions before decode; an over-limit image throws
    // (caught below → ImageNormalisationError → 415) rather than allocating
    // a multi-hundred-MB pixel buffer. For SVG the "dimensions" are the
    // rasterised canvas size librsvg computes from the width/height/viewBox.
    limitInputPixels: MAX_IMAGE_PIXELS,
  });

  // Metadata posture: pass `withMetadata({})` (empty options) for the
  // strip-all default. When stripMetadata=false (rare opt-out for photo-
  // management workflows), we pass through the metadata sharp keeps by
  // default — but the embedded thumbnail still gets dropped because the
  // decode-encode round trip discards it regardless. (SVG has no raster
  // metadata to carry, so this is a no-op for the rasterise path.)
  const formatPipeline = withFormat(pipeline, outMime);
  if (!stripMetadata) {
    // Keep EXIF / IPTC / XMP but the embedded thumbnail-of-original is
    // gone (sharp doesn't re-write thumbnails on encode).
    formatPipeline.withMetadata();
  }
  // Otherwise the default is "no metadata at all" — sharp doesn't carry
  // EXIF / IPTC / XMP / ICC unless explicitly told to via .withMetadata().

  let out: Buffer;
  let info: sharp.OutputInfo;
  // F-17 — bound concurrent decodes. Acquire before the (memory-heavy)
  // toBuffer(); always release in finally so a throw can't leak a permit.
  await sharpSemaphore.acquire();
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
  } finally {
    sharpSemaphore.release();
  }

  return {
    bytes: out,
    mime: outMime,
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

/**
 * Whether `mime` is a format the normaliser actively processes. Includes SVG
 * (F-13): SVG is routed through `normaliseImage`, which rasterises it to PNG —
 * so the caller MUST take the output `mime` from the NormaliseResult, since an
 * SVG input is stored as `image/png`.
 */
export function isNormalisable(mime: string): boolean {
  return mime === SVG_MIME || NORMALISABLE.has(mime);
}
