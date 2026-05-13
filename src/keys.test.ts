import { describe, it, expect } from "vitest";
import { generateApiKey, generateToken, hashKey, keyPrefix } from "./keys.js";

describe("keys", () => {
  it("generates a 'pane_' prefixed api key with 32 hex chars", () => {
    const k = generateApiKey();
    expect(k).toMatch(/^pane_[0-9a-f]{32}$/);
  });

  it("generates a base64url token of 43 chars", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBe(43);
  });

  it("hashKey is deterministic and returns 64 hex chars", () => {
    expect(hashKey("foo")).toBe(hashKey("foo"));
    expect(hashKey("foo")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey("foo")).not.toBe(hashKey("bar"));
  });

  it("keyPrefix for an api key returns 11 chars and is a prefix of the key", () => {
    const k = generateApiKey();
    const p = keyPrefix(k);
    expect(p.length).toBe(11);
    expect(k.startsWith(p)).toBe(true);
  });

  it("keyPrefix for a token returns 8 chars and is a prefix of the token", () => {
    const t = generateToken();
    const p = keyPrefix(t);
    expect(p.length).toBe(8);
    expect(t.startsWith(p)).toBe(true);
  });
});
