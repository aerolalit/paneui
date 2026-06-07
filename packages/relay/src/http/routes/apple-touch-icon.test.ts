// Unit tests for the per-pane home-screen icon renderer. The composite + robot
// fallback logic is exercised with fakes here; the route wiring (auth, headers,
// 304, shell link) is covered in bridge/routes.e2e.test.ts.

import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { PrismaClient } from "@prisma/client";
import type { AttachmentStore } from "../../attachments/store.js";
import { compositeOnTile, paneAppleTouchIcon } from "./apple-touch-icon.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const ROBOT_ETAG = '"atc-robot-v2"';

async function makePng(
  w: number,
  h: number,
  rgb: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { ...rgb, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe("compositeOnTile", () => {
  it("renders any source raster (incl. non-square) to a 180x180 PNG", async () => {
    const out = await compositeOnTile(
      await makePng(64, 40, { r: 255, g: 0, b: 0 }),
    );
    const meta = await sharp(Buffer.from(out)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(180);
    expect(meta.height).toBe(180);
  });
});

describe("paneAppleTouchIcon", () => {
  it("falls back to the robot app icon when there is no image icon", async () => {
    const res = await paneAppleTouchIcon(
      undefined,
      {} as unknown as PrismaClient,
      null,
    );
    expect(res.etag).toBe(ROBOT_ETAG);
    expect(Array.from(res.png.slice(0, 4))).toEqual(PNG_MAGIC);
    const meta = await sharp(Buffer.from(res.png)).metadata();
    expect(meta.width).toBe(180);
    expect(meta.height).toBe(180);
  });

  it("falls back to the robot when the blob store is not configured", async () => {
    const prisma = {
      attachment: { findUnique: async () => null },
    } as unknown as PrismaClient;
    const res = await paneAppleTouchIcon(undefined, prisma, "att_x");
    expect(res.etag).toBe(ROBOT_ETAG);
  });

  it("falls back to the robot when the attachment row is not ready", async () => {
    const prisma = {
      attachment: {
        findUnique: async () => ({ status: "pending", deletedAt: null }),
      },
    } as unknown as PrismaClient;
    const store = { get: async () => null } as unknown as AttachmentStore;
    const res = await paneAppleTouchIcon(store, prisma, "att_1");
    expect(res.etag).toBe(ROBOT_ETAG);
  });

  it("composites a ready image icon onto the brand tile; ETag carries the source hash", async () => {
    const srcPng = await makePng(48, 48, { r: 0, g: 0, b: 255 });
    const store = {
      get: async () => Readable.from(srcPng),
    } as unknown as AttachmentStore;
    const prisma = {
      attachment: {
        findUnique: async () => ({
          id: "att_1",
          status: "ready",
          deletedAt: null,
          storageKey: "attachment_att_1",
          sha256: "deadbeef",
          encryptionEnvelope: null,
          mime: "image/png",
        }),
      },
    } as unknown as PrismaClient;

    const res = await paneAppleTouchIcon(store, prisma, "att_1");
    expect(res.etag).toBe('"atc2-deadbeef"');
    expect(Array.from(res.png.slice(0, 4))).toEqual(PNG_MAGIC);
    const meta = await sharp(Buffer.from(res.png)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(180);
    expect(meta.height).toBe(180);
  });

  it("falls back to the robot when the source bytes are not a decodable image", async () => {
    const store = {
      get: async () => Readable.from(Buffer.from("this is not an image")),
    } as unknown as AttachmentStore;
    const prisma = {
      attachment: {
        findUnique: async () => ({
          id: "att_2",
          status: "ready",
          deletedAt: null,
          storageKey: "attachment_att_2",
          sha256: "cafe",
          encryptionEnvelope: null,
          mime: "image/png",
        }),
      },
    } as unknown as PrismaClient;

    const res = await paneAppleTouchIcon(store, prisma, "att_2");
    expect(res.etag).toBe(ROBOT_ETAG);
  });

  it("renders an emoji icon onto the pane's gradient tile when there is no image", async () => {
    const prisma = {} as unknown as PrismaClient;
    const res = await paneAppleTouchIcon(
      undefined,
      prisma,
      null,
      "📊",
      "pan_a",
    );
    // Not the robot — a real composited tile, keyed by code point + hue.
    expect(res.etag).not.toBe(ROBOT_ETAG);
    expect(res.etag).toContain("emoji-1f4ca-");
    expect(Array.from(res.png.slice(0, 4))).toEqual(PNG_MAGIC);
    const meta = await sharp(Buffer.from(res.png)).metadata();
    expect(meta.width).toBe(180);
    expect(meta.height).toBe(180);
  });

  it("derives the same gradient hue from the seed across calls (stable ETag)", async () => {
    const a = await paneAppleTouchIcon(
      undefined,
      {} as PrismaClient,
      null,
      "🗳️",
      "pan_x",
    );
    const b = await paneAppleTouchIcon(
      undefined,
      {} as PrismaClient,
      null,
      "🗳️",
      "pan_x",
    );
    expect(a.etag).toBe(b.etag);
    // Variation-selector (U+FE0F) is stripped → twemoji basename has no -fe0f.
    expect(a.etag).toContain("emoji-1f5f3-");
  });

  it("prefers the image icon over the emoji when both are present", async () => {
    const srcPng = await makePng(48, 48, { r: 0, g: 200, b: 0 });
    const store = {
      get: async () => Readable.from(srcPng),
    } as unknown as AttachmentStore;
    const prisma = {
      attachment: {
        findUnique: async () => ({
          id: "att_3",
          status: "ready",
          deletedAt: null,
          storageKey: "attachment_att_3",
          sha256: "feed",
          encryptionEnvelope: null,
          mime: "image/png",
        }),
      },
    } as unknown as PrismaClient;
    const res = await paneAppleTouchIcon(store, prisma, "att_3", "📊", "pan_a");
    expect(res.etag).toBe('"atc2-feed"'); // image won, not the emoji tile
  });

  it("falls back to the robot for a non-emoji / unknown glyph string", async () => {
    const res = await paneAppleTouchIcon(
      undefined,
      {} as PrismaClient,
      null,
      "xyz",
      "pan_a",
    );
    expect(res.etag).toBe(ROBOT_ETAG);
  });
});
