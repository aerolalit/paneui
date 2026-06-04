import { describe, it, expect } from "vitest";
import {
  validateIconEmoji,
  isValidIconEmoji,
  isRasterImageMime,
} from "./icons.js";

describe("validateIconEmoji", () => {
  it("accepts a single emoji grapheme", () => {
    for (const e of ["🚀", "📋", "🌟", "🎯", "❤️"]) {
      expect(validateIconEmoji(e).ok, e).toBe(true);
    }
  });

  it("accepts a ZWJ sequence as one grapheme", () => {
    // Family emoji — multiple code points joined with ZWJ, one grapheme.
    expect(isValidIconEmoji("👨‍👩‍👧")).toBe(true);
  });

  it("rejects plain ASCII letters / digits", () => {
    for (const s of ["a", "A", "1", "AB", "hi"]) {
      expect(validateIconEmoji(s).ok, s).toBe(false);
    }
  });

  it("rejects an empty string", () => {
    expect(validateIconEmoji("").ok).toBe(false);
  });

  it("rejects more than one grapheme", () => {
    expect(validateIconEmoji("🚀🚀").ok).toBe(false);
    expect(validateIconEmoji("🚀x").ok).toBe(false);
  });

  it("rejects control characters", () => {
    expect(validateIconEmoji(String.fromCharCode(0)).ok).toBe(false);
    expect(validateIconEmoji(String.fromCharCode(0x1f)).ok).toBe(false);
    expect(validateIconEmoji(String.fromCharCode(10)).ok).toBe(false);
  });

  it("rejects a long string over the byte cap", () => {
    expect(validateIconEmoji("🚀".repeat(40)).ok).toBe(false);
  });
});

describe("isRasterImageMime", () => {
  it("accepts the raster allowlist", () => {
    for (const m of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(isRasterImageMime(m), m).toBe(true);
    }
  });

  it("normalises case + charset parameter", () => {
    expect(isRasterImageMime("IMAGE/PNG")).toBe(true);
    expect(isRasterImageMime("image/jpeg; charset=binary")).toBe(true);
  });

  it("rejects svg, non-raster, and non-image types", () => {
    for (const m of [
      "image/svg+xml",
      "image/avif",
      "application/pdf",
      "text/html",
      "",
      null,
      undefined,
    ]) {
      expect(isRasterImageMime(m as string), String(m)).toBe(false);
    }
  });
});
