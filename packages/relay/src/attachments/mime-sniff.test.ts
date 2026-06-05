// Unit tests for mime-sniff — verifies magic-byte detection of every MIME
// the default BLOB_MIME_ALLOWLIST covers, and that unknown headers fall
// back to application/octet-stream.

import { describe, it, expect } from "vitest";
import { sniffMime, isMimeAllowed } from "./mime-sniff.js";

function bytes(hexOrAscii: string | number[]): Uint8Array {
  if (typeof hexOrAscii === "string") {
    return new TextEncoder().encode(hexOrAscii);
  }
  return new Uint8Array(hexOrAscii);
}

describe("sniffMime — image formats", () => {
  it("detects JPEG by FF D8 FF SOI marker", () => {
    expect(sniffMime(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(bytes([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
  });

  it("detects PNG by full 8-byte signature", () => {
    expect(
      sniffMime(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("image/png");
  });

  it("does NOT detect PNG from a partial signature", () => {
    // First 4 bytes only — must require all 8 to avoid ambiguity with random
    // binary that happens to start `89 50 4E 47`.
    expect(sniffMime(bytes([0x89, 0x50, 0x4e, 0x47]))).toBe(
      "application/octet-stream",
    );
  });

  it("detects GIF87a + GIF89a", () => {
    expect(sniffMime(bytes("GIF87a"))).toBe("image/gif");
    expect(sniffMime(bytes("GIF89a"))).toBe("image/gif");
  });

  it("detects WebP via RIFF...WEBP container", () => {
    const buf = new Uint8Array(12);
    buf.set(bytes("RIFF"), 0);
    buf[4] = buf[5] = buf[6] = buf[7] = 0x00; // file length placeholder
    buf.set(bytes("WEBP"), 8);
    expect(sniffMime(buf)).toBe("image/webp");
  });
});

describe("sniffMime — audio formats", () => {
  it("detects WAV via RIFF...WAVE container", () => {
    const buf = new Uint8Array(12);
    buf.set(bytes("RIFF"), 0);
    buf[4] = buf[5] = buf[6] = buf[7] = 0x00;
    buf.set(bytes("WAVE"), 8);
    expect(sniffMime(buf)).toBe("audio/wav");
  });

  it("detects MP3 with ID3v2 tag", () => {
    expect(sniffMime(bytes("ID3\x04\x00"))).toBe("audio/mpeg");
  });

  it("detects MP3 frame sync (no ID3 header)", () => {
    expect(sniffMime(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe(
      "audio/mpeg",
    );
    expect(sniffMime(new Uint8Array([0xff, 0xf3, 0x90, 0x00]))).toBe(
      "audio/mpeg",
    );
    expect(sniffMime(new Uint8Array([0xff, 0xf2, 0x90, 0x00]))).toBe(
      "audio/mpeg",
    );
  });

  it("detects Ogg container", () => {
    expect(sniffMime(bytes("OggS\x00"))).toBe("audio/ogg");
  });
});

describe("sniffMime — video formats", () => {
  it("detects MP4 via ftyp box + isom brand", () => {
    const buf = new Uint8Array(12);
    buf.set([0x00, 0x00, 0x00, 0x20], 0); // size (ignored by sniff)
    buf.set(bytes("ftyp"), 4);
    buf.set(bytes("isom"), 8);
    expect(sniffMime(buf)).toBe("video/mp4");
  });

  it("detects MP4 via ftyp + mp42 brand", () => {
    const buf = new Uint8Array(12);
    buf.set([0x00, 0x00, 0x00, 0x18], 0);
    buf.set(bytes("ftyp"), 4);
    buf.set(bytes("mp42"), 8);
    expect(sniffMime(buf)).toBe("video/mp4");
  });

  it("detects QuickTime via ftyp + 'qt  ' brand", () => {
    const buf = new Uint8Array(12);
    buf.set([0x00, 0x00, 0x00, 0x14], 0);
    buf.set(bytes("ftyp"), 4);
    buf.set(bytes("qt  "), 8);
    expect(sniffMime(buf)).toBe("video/quicktime");
  });

  it("detects WebM (Matroska EBML)", () => {
    expect(sniffMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]))).toBe(
      "video/webm",
    );
  });

  it("returns octet-stream for ftyp with an unknown brand", () => {
    const buf = new Uint8Array(12);
    buf.set(bytes("ftyp"), 4);
    buf.set(bytes("XXXX"), 8);
    expect(sniffMime(buf)).toBe("application/octet-stream");
  });
});

describe("sniffMime — SVG", () => {
  it("detects bare <svg>", () => {
    expect(sniffMime(bytes('<svg xmlns="http://x">'))).toBe("image/svg+xml");
  });

  it("detects <svg> after an XML declaration", () => {
    expect(sniffMime(bytes('<?xml version="1.0"?><svg width="10">'))).toBe(
      "image/svg+xml",
    );
  });

  it("detects <svg> after a UTF-8 BOM", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = bytes("<svg>");
    const buf = new Uint8Array(bom.length + body.length);
    buf.set(bom, 0);
    buf.set(body, bom.length);
    expect(sniffMime(buf)).toBe("image/svg+xml");
  });

  it("is case-insensitive on the tag", () => {
    expect(sniffMime(bytes('<SVG xmlns="...">'))).toBe("image/svg+xml");
  });
});

describe("sniffMime — PDF", () => {
  it("detects %PDF- header", () => {
    expect(sniffMime(bytes("%PDF-1.4\n"))).toBe("application/pdf");
  });
});

describe("sniffMime — unknown / hostile", () => {
  it("returns octet-stream for HTML (defends against polyglot mislabelling)", () => {
    expect(sniffMime(bytes("<!doctype html><html>..."))).toBe(
      "application/octet-stream",
    );
    expect(sniffMime(bytes("<html><head>"))).toBe("application/octet-stream");
  });

  it("returns octet-stream for plain text", () => {
    expect(sniffMime(bytes("hello world"))).toBe("application/octet-stream");
  });

  it("returns octet-stream for empty input", () => {
    expect(sniffMime(new Uint8Array(0))).toBe("application/octet-stream");
  });

  it("returns octet-stream for short JPEG-prefix (less than 3 bytes)", () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8]))).toBe(
      "application/octet-stream",
    );
  });
});

describe("isMimeAllowed", () => {
  it("matches prefix-style allowlist entries", () => {
    const allow = ["image/", "application/pdf"];
    expect(isMimeAllowed("image/jpeg", allow)).toBe(true);
    expect(isMimeAllowed("image/png", allow)).toBe(true);
    expect(isMimeAllowed("image/webp", allow)).toBe(true);
    expect(isMimeAllowed("application/pdf", allow)).toBe(true);

    expect(isMimeAllowed("text/html", allow)).toBe(false);
    expect(isMimeAllowed("application/octet-stream", allow)).toBe(false);
    expect(isMimeAllowed("video/mp4", allow)).toBe(false);
  });

  it("fails CLOSED on an empty allowlist (must not accept-any)", () => {
    // F-12: an empty allowlist must reject, never fail open. The
    // accidental-empty `BLOB_MIME_ALLOWLIST=` case is normalised to the
    // secure default in config.ts before it reaches here, but the function
    // itself must not fail open even if called with [].
    expect(isMimeAllowed("anything/at-all", [])).toBe(false);
    expect(isMimeAllowed("application/octet-stream", [])).toBe(false);
    expect(isMimeAllowed("image/png", [])).toBe(false);
  });

  it("accepts everything only via the explicit `*` sentinel", () => {
    expect(isMimeAllowed("anything/at-all", ["*"])).toBe(true);
    expect(isMimeAllowed("application/octet-stream", ["*"])).toBe(true);
    expect(isMimeAllowed("image/svg+xml", ["*"])).toBe(true);
  });

  it("does not admit svg under the explicit raster+pdf default", () => {
    const allow = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
    ];
    expect(isMimeAllowed("image/png", allow)).toBe(true);
    expect(isMimeAllowed("application/pdf", allow)).toBe(true);
    expect(isMimeAllowed("image/svg+xml", allow)).toBe(false);
  });
});
