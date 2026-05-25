import { describe, it, expect } from "vitest";
import { generateClaimCode, hashClaimCode } from "./claim.js";

describe("claim-code helpers", () => {
  it("generateClaimCode uses the cc_ prefix", () => {
    expect(generateClaimCode().startsWith("cc_")).toBe(true);
  });

  it("generateClaimCode returns distinct values", () => {
    expect(generateClaimCode()).not.toBe(generateClaimCode());
  });

  it("hashClaimCode is deterministic + sha256-shaped", () => {
    const c = "cc_abc";
    expect(hashClaimCode(c)).toBe(hashClaimCode(c));
    expect(hashClaimCode(c)).toMatch(/^[0-9a-f]{64}$/);
  });
});
