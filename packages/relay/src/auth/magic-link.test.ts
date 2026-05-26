import { describe, it, expect } from "vitest";
import {
  buildMagicLinkUrl,
  generateMagicLinkToken,
  hashMagicLinkToken,
  normalizeEmail,
} from "./magic-link.js";

describe("magic-link helpers", () => {
  describe("generateMagicLinkToken", () => {
    it("uses the ml_ prefix", () => {
      expect(generateMagicLinkToken().startsWith("ml_")).toBe(true);
    });

    it("returns distinct values", () => {
      expect(generateMagicLinkToken()).not.toBe(generateMagicLinkToken());
    });
  });

  describe("hashMagicLinkToken", () => {
    it("is deterministic + sha256-shaped", () => {
      const t = "ml_abc";
      const h = hashMagicLinkToken(t);
      expect(hashMagicLinkToken(t)).toBe(h);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("buildMagicLinkUrl", () => {
    it("appends /v1/auth/verify and the token query param", () => {
      const url = buildMagicLinkUrl({
        publicUrl: "https://relay.test",
        token: "ml_abc",
      });
      expect(url).toBe("https://relay.test/v1/auth/verify?token=ml_abc");
    });

    it("trims a trailing slash on the public URL", () => {
      const url = buildMagicLinkUrl({
        publicUrl: "https://relay.test/",
        token: "ml_abc",
      });
      expect(url).toBe("https://relay.test/v1/auth/verify?token=ml_abc");
    });

    it("URL-encodes special chars in the token", () => {
      const url = buildMagicLinkUrl({
        publicUrl: "https://relay.test",
        token: "ml_a+b",
      });
      // %2B encodes '+', proving the encode happened.
      expect(url).toContain("%2B");
    });
  });

  describe("normalizeEmail", () => {
    it("lowercases", () => {
      expect(normalizeEmail("Alice@Example.com")).toBe("alice@example.com");
    });
    it("trims whitespace", () => {
      expect(normalizeEmail("  alice@example.com  ")).toBe("alice@example.com");
    });
    it("does nothing extra on an already-normalized address", () => {
      expect(normalizeEmail("alice@example.com")).toBe("alice@example.com");
    });
  });
});
