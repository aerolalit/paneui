// Per-pane home-screen icon (iOS "Add to Home Screen" / apple-touch-icon) for
// the share-link viewer at GET /s/:token. iOS needs a real PNG (it ignores SVG
// for the home screen), so we resolve the pane's effective icon to a 180×180
// PNG, falling back to the robot app icon.
//
// Resolution order mirrors the in-app tile precedence — image beats emoji:
//   pane image → template image → pane/template EMOJI on the gradient tile →
//   robot default.
//
// Emoji icons are rendered by compositing the matching @twemoji/svg glyph (a
// flat-color vector — no color-emoji font / fontconfig dependency, so it renders
// identically on macOS dev and the Debian image) onto the pane's hashed gradient
// tile, the same gradient the in-app monogram uses. The resolver ALWAYS yields a
// real 180×180 PNG and never 404s, so iOS never falls back to a page screenshot.

import sharp from "sharp";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import type { AttachmentStore } from "../../attachments/store.js";
import { APP_ICON_180_PNG } from "../../app-icon.js";

// Resolve @twemoji/svg glyph files at runtime. The package is a production
// dependency, so its SVGs ship in node_modules under `npm ci --omit=dev` — no
// static-asset directory needed. createRequire gives us require.resolve in this
// ESM module.
const requireFromHere = createRequire(import.meta.url);

// 180×180 is the canonical apple-touch-icon size. The tile coral matches the
// brand mark's own background (brand.ts), so a contained icon sits on the same
// field as the robot default and iOS masks the square to a squircle cleanly.
const TILE = 180;
const TILE_BG = "#D97757";
// Emoji glyph box on the tile — ~60% of the tile, which reads well after iOS
// masks the square down to a squircle.
const EMOJI_PX = 108;

// ETag for the robot fallback — its bytes are build-time-constant. Bump the
// version tag if APP_ICON_180_PNG or the composite logic changes so cached
// clients re-fetch.
const ROBOT_ETAG = '"atc-robot-v2"';
const RENDER_VERSION = "atc2";

export interface AppleTouchIcon {
  png: Uint8Array;
  etag: string;
}

// Fetch + decrypt a ready attachment's bytes. Mirrors the decrypt path in
// routes/icons.ts streamIcon (and routes/attachments.ts) — buffered rather than
// streamed because we hand the bytes straight to sharp. Returns null on any
// miss (missing/not-ready/deleted row, or storage gap) so the caller falls back
// to the robot default.
async function loadDecryptedAttachment(
  store: AttachmentStore,
  prisma: PrismaClient,
  attachmentId: string,
): Promise<{ bytes: Uint8Array; sha256: string } | null> {
  const row = await prisma.attachment.findUnique({
    where: { id: attachmentId },
  });
  if (!row || row.status !== "ready" || row.deletedAt !== null) return null;

  const stream = await store.get(row.storageKey);
  if (!stream) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);

  let bytes: Uint8Array = raw;
  if (row.encryptionEnvelope) {
    const { decryptBlob, parseEnvelope } =
      await import("../../attachments/encrypt.js");
    const { getMasterKey } = await import("../../crypto.js");
    bytes = decryptBlob(
      raw,
      parseEnvelope(row.encryptionEnvelope),
      getMasterKey(),
    );
  }
  return { bytes, sha256: row.sha256 };
}

// Twemoji's filename rule (grabTheRightIcon): drop the U+FE0F variation
// selector UNLESS the sequence contains a ZWJ (U+200D), then join the lowercase
// hex code points with '-'. Produces the exact basename of the @twemoji/svg
// asset, e.g. "📊" → "1f4ca", "1️⃣" → "31-20e3", "❤️‍🔥" → "2764-fe0f-200d-1f525".
function emojiToCodePoint(emoji: string): string {
  // Drop the variation selector (U+FE0F) unless the sequence contains a ZWJ
  // (U+200D) — Twemoji's grabTheRightIcon rule. Code points are referenced
  // numerically so no invisible characters live in the source.
  const ZWJ = 0x200d;
  const VS16 = 0xfe0f;
  const points = Array.from(emoji);
  const hasZwj = points.some((ch) => ch.codePointAt(0) === ZWJ);
  const s = hasZwj
    ? emoji
    : points.filter((ch) => ch.codePointAt(0) !== VS16).join("");
  const out: string[] = [];
  let hi = 0;
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i++);
    if (hi) {
      out.push((0x10000 + ((hi - 0xd800) << 10) + (c - 0xdc00)).toString(16));
      hi = 0;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      hi = c;
    } else {
      out.push(c.toString(16));
    }
  }
  return out.join("-");
}

// Hashed hue for the pane's gradient tile — byte-identical to the in-app tile
// monogram (owner-shell-spa.ts paneHue) so the home-screen icon sits on the
// same gradient the user already sees on the pane's tile in the app.
function paneHue(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

// Render the pane's emoji onto its hashed gradient tile as a 180×180 PNG.
// Twemoji SVGs are flat-color vectors, so this renders identically everywhere
// (no color-emoji font / fontconfig dependency). Returns null — caller falls
// back to the robot — when the string isn't a known Twemoji glyph or any step
// of the raster pipeline fails; the home-screen icon must always resolve.
async function renderEmojiTile(
  emoji: string,
  seedId: string,
): Promise<AppleTouchIcon | null> {
  const cp = emojiToCodePoint(emoji.trim());
  if (!cp) return null;
  let svgPath: string;
  try {
    svgPath = requireFromHere.resolve(`@twemoji/svg/${cp}.svg`);
  } catch {
    return null; // not a Twemoji glyph (or an unexpected non-emoji string)
  }
  try {
    const glyphSvg = await readFile(svgPath);
    const hue = paneHue(seedId);
    // 135°-equivalent gradient (top-left → bottom-right), same stops as the
    // in-app monogram tile.
    const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},80%,70%)"/><stop offset="1" stop-color="hsl(${(hue + 30) % 360},75%,60%)"/></linearGradient></defs><rect width="${TILE}" height="${TILE}" fill="url(#g)"/></svg>`;
    const bgPng = await sharp(Buffer.from(bg)).png().toBuffer();
    const glyphPng = await sharp(glyphSvg)
      .resize(EMOJI_PX, EMOJI_PX, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    const png = await sharp(bgPng)
      .composite([{ input: glyphPng, gravity: "center" }])
      .png()
      .toBuffer();
    return { png, etag: `"${RENDER_VERSION}-emoji-${cp}-h${hue}"` };
  } catch {
    return null;
  }
}

// Composite a source raster onto the brand tile: contain-fit within 180×180 and
// flatten any transparency onto the navy, so iOS gets a clean opaque square.
// First frame only for animated inputs (sharp default). Exported for unit tests.
export async function compositeOnTile(src: Uint8Array): Promise<Uint8Array> {
  return sharp(src, { failOn: "none" })
    .resize(TILE, TILE, { fit: "contain", background: TILE_BG })
    .flatten({ background: TILE_BG })
    .png()
    .toBuffer();
}

// Resolve a pane's effective icon to a 180×180 PNG, mirroring the in-app tile
// precedence: image icon → emoji-on-gradient-tile → robot default. Falls all
// the way back to the robot whenever there's no image/emoji, an asset is
// missing, or anything can't be read/decoded — the home-screen icon must always
// render something (a 404 would leave iOS with a page screenshot).
export async function paneAppleTouchIcon(
  store: AttachmentStore | undefined,
  prisma: PrismaClient,
  effectiveAttachmentId: string | null,
  emoji?: string | null,
  seedId?: string,
): Promise<AppleTouchIcon> {
  if (store && effectiveAttachmentId) {
    const att = await loadDecryptedAttachment(
      store,
      prisma,
      effectiveAttachmentId,
    );
    if (att) {
      try {
        const png = await compositeOnTile(att.bytes);
        return { png, etag: `"${RENDER_VERSION}-${att.sha256}"` };
      } catch {
        // Corrupt/undecodable image → fall through to emoji/robot rather than 500.
      }
    }
  }
  // No usable image icon — render the emoji on the pane's gradient tile. Needs
  // both the emoji and a seed (the pane id) for the gradient hue.
  if (emoji && seedId) {
    const tile = await renderEmojiTile(emoji, seedId);
    if (tile) return tile;
  }
  return { png: APP_ICON_180_PNG, etag: ROBOT_ETAG };
}
