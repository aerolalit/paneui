// Per-pane home-screen icon (iOS "Add to Home Screen" / apple-touch-icon) for
// the share-link viewer at GET /s/:token. iOS needs a real PNG (it ignores SVG
// for the home screen), so we resolve the pane's effective IMAGE icon and
// composite it onto the brand tile, falling back to the robot app icon.
//
// Scope: IMAGE icons only. A pane/template can also have an emoji icon, but
// rasterising an emoji server-side needs a font/asset pipeline that isn't worth
// it here — emoji-only and no-icon panes both resolve to the robot default. The
// resolver therefore ALWAYS yields a real 180×180 PNG and never 404s, so iOS
// never falls back to a page screenshot.
//
// Resolution order (mirrors the in-app tile precedence — image beats emoji):
//   pane image → template image → robot default.

import sharp from "sharp";
import type { PrismaClient } from "@prisma/client";
import type { AttachmentStore } from "../../attachments/store.js";
import { APP_ICON_180_PNG } from "../../app-icon.js";

// 180×180 is the canonical apple-touch-icon size. The tile coral matches the
// brand mark's own background (brand.ts), so a contained icon sits on the same
// field as the robot default and iOS masks the square to a squircle cleanly.
const TILE = 180;
const TILE_BG = "#D97757";

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

// Resolve an effective image-attachment id (or null) to a 180×180 PNG. Falls
// back to the robot whenever there's no image icon, the blob store is
// unavailable, or the attachment can't be read/decoded — the home-screen icon
// must always render something.
export async function paneAppleTouchIcon(
  store: AttachmentStore | undefined,
  prisma: PrismaClient,
  effectiveAttachmentId: string | null,
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
        // Corrupt/undecodable image → robot default rather than a 500.
      }
    }
  }
  return { png: APP_ICON_180_PNG, etag: ROBOT_ETAG };
}
