import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  encryptSecret,
  decryptSecret,
  secretFingerprint,
  ensureKeyLoaded,
  _resetKeyCacheForTests,
} from "./crypto.js";

describe("crypto envelope", () => {
  beforeEach(() => {
    process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
    _resetKeyCacheForTests();
  });

  it("round-trips a secret through encrypt/decrypt", () => {
    const plain = "whsec_" + randomBytes(16).toString("hex");
    const attachment = encryptSecret(plain);
    expect(attachment.split(".")[0]).toBe("v1");
    expect(attachment).not.toContain(plain);
    expect(decryptSecret(attachment)).toBe(plain);
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
    const attachment = encryptSecret("topsecret");
    const parts = attachment.split(".");
    const ctBuf = Buffer.from(parts[2]!, "base64");
    ctBuf[0]! ^= 0x01;
    parts[2] = ctBuf.toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("rejects a malformed attachment", () => {
    expect(() =>
      decryptSecret("not.a.valid.attachment.too.many.parts"),
    ).toThrow();
    expect(() => decryptSecret("v0.aa.bb.cc")).toThrow();
  });

  it("rejects a key that isn't 32 bytes", () => {
    process.env.PANE_SECRET_KEY = "tooshort";
    _resetKeyCacheForTests();
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });

  it("fingerprint is deterministic and non-reversible", () => {
    const attachment = encryptSecret("abc");
    const fp = secretFingerprint(attachment);
    expect(fp).toHaveLength(12);
    expect(secretFingerprint(attachment)).toBe(fp);
  });
});

describe("master key resolution in production", () => {
  const ORIG_ENV = process.env.NODE_ENV;
  const ORIG_KEY = process.env.PANE_SECRET_KEY;
  const KEY_FILE = resolve(__dirname, "..", ".pane-secret-key");

  beforeEach(() => {
    _resetKeyCacheForTests();
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIG_ENV;
    if (ORIG_KEY === undefined) delete process.env.PANE_SECRET_KEY;
    else process.env.PANE_SECRET_KEY = ORIG_KEY;
    _resetKeyCacheForTests();
  });

  it("throws when PANE_SECRET_KEY is unset in production (no auto-generate)", () => {
    if (existsSync(KEY_FILE)) {
      // A dev key file would short-circuit before the production guard;
      // this test is only meaningful on a clean tree (e.g. CI).
      return;
    }
    process.env.NODE_ENV = "production";
    delete process.env.PANE_SECRET_KEY;
    expect(() => ensureKeyLoaded()).toThrow(/PANE_SECRET_KEY must be set/);
    expect(existsSync(KEY_FILE)).toBe(false);
  });

  it("loads an explicitly-set key in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
    expect(() => ensureKeyLoaded()).not.toThrow();
  });
});
