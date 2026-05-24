// Unit tests for the attachment-token helpers — entropy, prefix discipline,
// hash determinism, and the cheap shape check.

import { describe, it, expect } from "vitest";
import {
  generateBlobToken,
  hashBlobToken,
  looksLikeBlobToken,
} from "./tokens.js";

describe("generateBlobToken", () => {
  it("returns a paneb_-prefixed token, hash, and short prefix", () => {
    const t = generateBlobToken();
    expect(t.token).toMatch(/^paneb_[A-Za-z0-9_-]{32}$/);
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.prefix).toBe(t.token.slice(0, 10));
    expect(t.prefix.startsWith("paneb_")).toBe(true);
  });

  it("never collides across 1000 generations (entropy sanity)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateBlobToken().token);
    }
    expect(seen.size).toBe(1000);
  });

  it("hash matches hashBlobToken(token) — round-trip", () => {
    const t = generateBlobToken();
    expect(hashBlobToken(t.token)).toBe(t.hash);
  });
});

describe("hashBlobToken", () => {
  it("is stable across calls", () => {
    expect(hashBlobToken("paneb_abc")).toBe(hashBlobToken("paneb_abc"));
  });

  it("changes with input", () => {
    expect(hashBlobToken("paneb_abc")).not.toBe(hashBlobToken("paneb_abd"));
  });
});

describe("looksLikeBlobToken", () => {
  it("accepts a real generated token", () => {
    expect(looksLikeBlobToken(generateBlobToken().token)).toBe(true);
  });

  it("rejects missing prefix", () => {
    expect(looksLikeBlobToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("rejects too-short body", () => {
    expect(looksLikeBlobToken("paneb_abc")).toBe(false);
  });

  it("rejects too-long body", () => {
    expect(looksLikeBlobToken("paneb_" + "a".repeat(40))).toBe(false);
  });

  it("rejects non-base64url characters in the body", () => {
    expect(looksLikeBlobToken("paneb_" + "a".repeat(31) + "/")).toBe(false);
    expect(looksLikeBlobToken("paneb_" + "a".repeat(31) + "+")).toBe(false);
    expect(looksLikeBlobToken("paneb_" + "a".repeat(31) + "=")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(looksLikeBlobToken("")).toBe(false);
  });
});
