// Unit tests for attachment envelope encryption — round trip, master-key
// dependence, tamper detection, and envelope serialisation.

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptBlob,
  encryptBlob,
  parseEnvelope,
  serialiseEnvelope,
  type AttachmentEncryptionEnvelope,
} from "./encrypt.js";

function master(): Buffer {
  return randomBytes(32);
}

describe("encryptBlob / decryptBlob — round trip", () => {
  it("plaintext → ciphertext → plaintext is identity", () => {
    const m = master();
    const pt = Buffer.from("the bytes of a small attachment", "utf8");
    const { ciphertext, envelope } = encryptBlob(pt, m);
    expect(ciphertext.equals(pt)).toBe(false); // it really did encrypt
    const back = decryptBlob(ciphertext, envelope, m);
    expect(back.equals(pt)).toBe(true);
  });

  it("handles larger payloads byte-for-byte", () => {
    const m = master();
    const pt = randomBytes(100_000);
    const { ciphertext, envelope } = encryptBlob(pt, m);
    const back = decryptBlob(ciphertext, envelope, m);
    expect(back.equals(pt)).toBe(true);
  });

  it("each call produces a unique envelope (random IV + DEK)", () => {
    const m = master();
    const pt = Buffer.from("same content twice");
    const a = encryptBlob(pt, m);
    const b = encryptBlob(pt, m);
    expect(a.envelope.wd).not.toBe(b.envelope.wd);
    expect(a.envelope.di).not.toBe(b.envelope.di);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });
});

describe("decryptBlob — tamper + wrong-key detection", () => {
  it("decrypting with the wrong master key throws", () => {
    const m1 = master();
    const m2 = master();
    const { ciphertext, envelope } = encryptBlob(Buffer.from("secret"), m1);
    expect(() => decryptBlob(ciphertext, envelope, m2)).toThrow();
  });

  it("flipping any byte of the ciphertext breaks the GCM tag", () => {
    const m = master();
    const { ciphertext, envelope } = encryptBlob(
      Buffer.from("the original bytes"),
      m,
    );
    const tampered = Buffer.from(ciphertext);
    tampered[0] = tampered[0]! ^ 0x01;
    expect(() => decryptBlob(tampered, envelope, m)).toThrow();
  });

  it("flipping any byte of the wrapped DEK breaks the master GCM tag", () => {
    const m = master();
    const { ciphertext, envelope } = encryptBlob(Buffer.from("x"), m);
    const wd = Buffer.from(envelope.wd, "base64");
    wd[0] = wd[0]! ^ 0x01;
    const tampered: AttachmentEncryptionEnvelope = {
      ...envelope,
      wd: wd.toString("base64"),
    };
    expect(() => decryptBlob(ciphertext, tampered, m)).toThrow();
  });
});

describe("envelope serialisation", () => {
  it("round-trips through serialise + parse", () => {
    const env: AttachmentEncryptionEnvelope = {
      v: 1,
      wd: Buffer.alloc(60, 0xaa).toString("base64"),
      di: Buffer.alloc(12, 0xbb).toString("base64"),
      dt: Buffer.alloc(16, 0xcc).toString("base64"),
    };
    const wire = serialiseEnvelope(env);
    const parsed = parseEnvelope(wire);
    expect(parsed).toEqual(env);
  });

  it("parseEnvelope rejects malformed input", () => {
    expect(() => parseEnvelope("not-base64???")).toThrow();
    expect(() =>
      parseEnvelope(Buffer.from("{}", "utf8").toString("base64")),
    ).toThrow();
    const bad = Buffer.from(
      JSON.stringify({ v: 2, wd: "x", di: "y", dt: "z" }),
      "utf8",
    ).toString("base64");
    expect(() => parseEnvelope(bad)).toThrow();
  });

  it("decryptBlob refuses an envelope with unknown version", () => {
    const env: AttachmentEncryptionEnvelope = {
      v: 99 as unknown as 1,
      wd: "AAA=",
      di: "BBB=",
      dt: "CCC=",
    };
    expect(() => decryptBlob(Buffer.alloc(0), env, master())).toThrow(
      /version/,
    );
  });
});
