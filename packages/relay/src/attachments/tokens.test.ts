// Unit tests for the attachment-token helpers — entropy, prefix discipline,
// hash determinism, and the cheap shape check.

import { describe, it, expect } from "vitest";
import {
  generateBlobToken,
  hashBlobToken,
  looksLikeBlobToken,
  extractBlobTokens,
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

describe("extractBlobTokens", () => {
  // A fixed, valid token shape (paneb_ + 32 base64url chars) for assertions.
  const T1 = "paneb_" + "A".repeat(32);
  const T2 = "paneb_" + "b".repeat(32);

  it("pulls a token out of a /b/<token> URL string", () => {
    expect(extractBlobTokens(`https://relay.example/b/${T1}`)).toEqual([T1]);
  });

  it("walks nested objects and arrays", () => {
    const input = {
      hero: `https://r/b/${T1}`,
      gallery: [{ src: `/b/${T2}` }, { src: `/b/${T1}` }],
    };
    // T1 appears twice but is deduped; first-seen order is preserved.
    expect(extractBlobTokens(input)).toEqual([T1, T2]);
  });

  it("finds a token embedded in markdown / HTML, not just a bare URL", () => {
    const md = `![photo](https://r/b/${T1}) and <img src="/b/${T2}">`;
    expect(extractBlobTokens(md)).toEqual([T1, T2]);
  });

  it("returns [] when there are no tokens", () => {
    expect(
      extractBlobTokens({ a: 1, b: "no tokens here", c: [true, null] }),
    ).toEqual([]);
  });

  it("ignores a paneb_ run that is too long to be a token", () => {
    // 33 base64url chars after the prefix — not a valid 24-byte token.
    expect(extractBlobTokens(`/b/paneb_${"a".repeat(33)}`)).toEqual([]);
  });

  it("ignores a paneb_ run glued onto preceding base64url bytes", () => {
    // `x` immediately before the prefix means this isn't a clean token start.
    expect(extractBlobTokens(`xpaneb_${"a".repeat(32)}`)).toEqual([]);
  });

  it("extracts a token that is immediately followed by a query string", () => {
    expect(extractBlobTokens(`/b/${T1}?download=1`)).toEqual([T1]);
  });

  it("handles non-object scalars without throwing", () => {
    expect(extractBlobTokens(null)).toEqual([]);
    expect(extractBlobTokens(42)).toEqual([]);
    expect(extractBlobTokens(undefined)).toEqual([]);
  });

  it("round-trips a freshly generated token", () => {
    const { token } = generateBlobToken();
    expect(extractBlobTokens(`/b/${token}`)).toEqual([token]);
  });
});
