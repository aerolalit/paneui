import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  secretFingerprint,
  _resetKeyCacheForTests,
} from "./crypto.js";

describe("crypto envelope", () => {
  beforeEach(() => {
    process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
    _resetKeyCacheForTests();
  });

  it("round-trips a secret through encrypt/decrypt", () => {
    const plain = "whsec_" + randomBytes(16).toString("hex");
    const blob = encryptSecret(plain);
    expect(blob.split(".")[0]).toBe("v1");
    expect(blob).not.toContain(plain);
    expect(decryptSecret(blob)).toBe(plain);
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const plain = "same-secret";
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plain);
    expect(decryptSecret(b)).toBe(plain);
  });

  it("fails to decrypt a tampered ciphertext", () => {
    const blob = encryptSecret("topsecret");
    const parts = blob.split(".");
    const ctBuf = Buffer.from(parts[2]!, "base64");
    ctBuf[0]! ^= 0x01;
    parts[2] = ctBuf.toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("rejects a malformed blob", () => {
    expect(() => decryptSecret("not.a.valid.blob.too.many.parts")).toThrow();
    expect(() => decryptSecret("v0.aa.bb.cc")).toThrow();
  });

  it("rejects a key that isn't 32 bytes", () => {
    process.env.PANE_SECRET_KEY = "tooshort";
    _resetKeyCacheForTests();
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });

  it("fingerprint is deterministic and non-reversible", () => {
    const blob = encryptSecret("abc");
    const fp = secretFingerprint(blob);
    expect(fp).toHaveLength(12);
    expect(secretFingerprint(blob)).toBe(fp);
  });
});
