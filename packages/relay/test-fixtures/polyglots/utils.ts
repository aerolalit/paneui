// Builder helpers for the polyglot corpus. Tracked in git so PRs that add
// new fixtures show up as plain code review, not as binary diffs.
//
// All builders return raw bytes. The corpus loader (index.ts) pairs them
// with the matching <name>.meta.json sidecar and feeds the assembled list
// into normalize.test.ts. The same builder is run on every test run, so
// the fixtures are reproducible — no hidden source-of-truth binary attachment.

import { deflateSync } from "node:zlib";
import sharp from "sharp";

// node:zlib.crc32() lives in Node 22+; the relay engines field allows
// Node 20. Ship a tiny inline CRC32 keyed for PNG chunk integrity so the
// corpus builds on whatever Node CI happens to be running.
const CRC32_TABLE: number[] = (() => {
  const t = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Wrap raw chunk data in the PNG `<length><type><data><crc>` framing.
 * `type` is the 4-byte ASCII chunk type ("iTXt", "zTXt", "tEXt", "IEND",
 * etc.). The CRC covers `type` + `data` — not the length.
 */
export function pngChunk(type: string, data: Buffer): Buffer {
  if (type.length !== 4) {
    throw new Error(`png chunk type must be 4 bytes, got ${type.length}`);
  }
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

/**
 * Insert one or more synthesized chunks immediately before the existing
 * IEND chunk of a PNG. Used to forge iTXt / zTXt / tEXt payloads that the
 * sharp re-encode is expected to drop.
 */
export function injectBeforeIend(png: Buffer, ...chunks: Buffer[]): Buffer {
  const IEND_TYPE = Buffer.from("IEND", "latin1");
  let iendOffset = -1;
  for (let i = 0; i <= png.length - 4; i++) {
    if (
      png[i] === IEND_TYPE[0] &&
      png[i + 1] === IEND_TYPE[1] &&
      png[i + 2] === IEND_TYPE[2] &&
      png[i + 3] === IEND_TYPE[3]
    ) {
      iendOffset = i;
      break;
    }
  }
  if (iendOffset < 0) {
    throw new Error("png has no IEND chunk — not a PNG?");
  }
  // IEND is preceded by its 4-byte length field.
  const cut = iendOffset - 4;
  return Buffer.concat([png.subarray(0, cut), ...chunks, png.subarray(cut)]);
}

/**
 * Inject a JPEG COM (FF FE) marker carrying `payload` right after the SOI
 * (FF D8). Decoders treat COM as a comment and skip it; sharp drops it on
 * re-encode. The marker shape is:
 *   FF FE <length-big-endian> <payload>
 * where length covers the length field + payload.
 */
export function injectJpegComSegment(jpeg: Buffer, payload: Buffer): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("not a jpeg (no SOI marker)");
  }
  const len = payload.length + 2;
  if (len > 0xffff) {
    throw new Error("jpeg COM payload too large");
  }
  const lenBytes = Buffer.alloc(2);
  lenBytes.writeUInt16BE(len, 0);
  const comSegment = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    lenBytes,
    payload,
  ]);
  // Insert just after SOI (offset 2).
  return Buffer.concat([jpeg.subarray(0, 2), comSegment, jpeg.subarray(2)]);
}

/** A tiny well-formed local ZIP file header + central directory ("empty
 * archive" shell). Used as a trailer for the GIFAR / jpeg-zip-trailer
 * fixtures so the trailing bytes look like a real polyglot, not random
 * garbage. */
export function tinyZipTrailer(filename = "polyglot.txt"): Buffer {
  const name = Buffer.from(filename, "latin1");
  const content = Buffer.from("polyglot test trailer", "latin1");
  // Local file header
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); // signature
  lfh.writeUInt16LE(20, 4); // version
  lfh.writeUInt16LE(0, 6); // flags
  lfh.writeUInt16LE(0, 8); // method (store)
  lfh.writeUInt16LE(0, 10); // mtime
  lfh.writeUInt16LE(0, 12); // mdate
  lfh.writeUInt32LE(0, 14); // crc32 (omitted for fixture purposes)
  lfh.writeUInt32LE(content.length, 18); // compressed size
  lfh.writeUInt32LE(content.length, 22); // uncompressed size
  lfh.writeUInt16LE(name.length, 26);
  lfh.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([lfh, name, content]);
}

/**
 * Pre-canned baseline images. Builders that need a known-good base call
 * these and append polyglot payloads.
 *
 * Dimensions are tiny (8x8, 16x16) on purpose: the corpus has to build
 * fast and reproducibly, and the polyglot defense doesn't depend on
 * resolution.
 */
export const baselines = {
  jpeg: async (w = 16, h = 16): Promise<Buffer> =>
    sharp({
      create: {
        width: w,
        height: h,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .jpeg()
      .toBuffer(),

  png: async (w = 16, h = 16): Promise<Buffer> =>
    sharp({
      create: {
        width: w,
        height: h,
        channels: 4,
        background: { r: 50, g: 200, b: 100, alpha: 1 },
      },
    })
      .png()
      .toBuffer(),

  gif: async (w = 16, h = 16): Promise<Buffer> =>
    sharp({
      create: {
        width: w,
        height: h,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .gif()
      .toBuffer(),

  webp: async (w = 16, h = 16): Promise<Buffer> =>
    sharp({
      create: {
        width: w,
        height: h,
        channels: 3,
        background: { r: 255, g: 0, b: 200 },
      },
    })
      .webp()
      .toBuffer(),
};

/** Re-export deflateSync so builders can craft zTXt chunks. */
export { deflateSync };
