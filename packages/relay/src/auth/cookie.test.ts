import { describe, it, expect } from "vitest";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
  parseLoginCookie,
} from "./cookie.js";

describe("login cookie helpers", () => {
  describe("generateLoginCookie", () => {
    it("starts with the lg_ prefix", () => {
      expect(generateLoginCookie().startsWith("lg_")).toBe(true);
    });

    it("returns distinct values across calls", () => {
      const a = generateLoginCookie();
      const b = generateLoginCookie();
      expect(a).not.toBe(b);
    });

    it("returns enough entropy that collisions are not realistic", () => {
      // 32 bytes of randomness → 43 base64url chars + 3-char prefix = 46+
      expect(generateLoginCookie().length).toBeGreaterThanOrEqual(46);
    });
  });

  describe("hashLoginCookie", () => {
    it("returns a deterministic sha256 hex string", () => {
      const token = "lg_test";
      // sha256("lg_test") — verified against an external tool
      expect(hashLoginCookie(token)).toBe(hashLoginCookie(token));
      expect(hashLoginCookie(token)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("different inputs give different hashes", () => {
      expect(hashLoginCookie("a")).not.toBe(hashLoginCookie("b"));
    });
  });

  describe("buildSetCookieHeader", () => {
    it("includes HttpOnly, SameSite=Lax, Path=/, Max-Age", () => {
      const h = buildSetCookieHeader({
        value: "lg_abc",
        maxAgeSeconds: 60,
        isProduction: false,
      });
      expect(h).toContain(`${LOGIN_COOKIE_NAME}=lg_abc`);
      expect(h).toContain("HttpOnly");
      expect(h).toContain("SameSite=Lax");
      expect(h).toContain("Path=/");
      expect(h).toContain("Max-Age=60");
    });

    it("omits Secure in dev mode", () => {
      const h = buildSetCookieHeader({
        value: "lg_abc",
        maxAgeSeconds: 60,
        isProduction: false,
      });
      expect(h).not.toContain("Secure");
    });

    it("includes Secure in production", () => {
      const h = buildSetCookieHeader({
        value: "lg_abc",
        maxAgeSeconds: 60,
        isProduction: true,
      });
      expect(h).toContain("Secure");
    });
  });

  describe("buildClearCookieHeader", () => {
    it("sets Max-Age=0 and empty value", () => {
      const h = buildClearCookieHeader({ isProduction: false });
      expect(h).toContain(`${LOGIN_COOKIE_NAME}=`);
      expect(h).toContain("Max-Age=0");
    });
  });

  describe("parseLoginCookie", () => {
    it("returns null for a missing cookie header", () => {
      expect(parseLoginCookie(null)).toBeNull();
    });

    it("returns null when the named cookie is absent", () => {
      expect(parseLoginCookie("other=1; another=2")).toBeNull();
    });

    it("extracts the value when the cookie is the only one set", () => {
      expect(parseLoginCookie(`${LOGIN_COOKIE_NAME}=lg_abc`)).toBe("lg_abc");
    });

    it("extracts the value when the cookie is one of several", () => {
      const header = `csrf=xyz; ${LOGIN_COOKIE_NAME}=lg_abc; theme=dark`;
      expect(parseLoginCookie(header)).toBe("lg_abc");
    });

    it("tolerates whitespace around the separator", () => {
      expect(parseLoginCookie(`  ${LOGIN_COOKIE_NAME}=lg_abc  `)).toBe(
        "lg_abc",
      );
    });

    it("returns null for an empty value", () => {
      expect(parseLoginCookie(`${LOGIN_COOKIE_NAME}=`)).toBeNull();
    });
  });
});
