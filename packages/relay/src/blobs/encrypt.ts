// Envelope encryption-at-rest for blob bytes.
//
// Per-blob random 32-byte data-encryption-key (DEK). The DEK is wrapped
// (encrypted) under the relay's master key — derived from PANE_SECRET_KEY,
// the same secret already used for webhook callback encryption (see
// http/webhook.ts and core/secrets.ts). Wrapped DEK + the data-side
// IV + tag are persisted in the Blob row's `encryption_envelope` column
// as a base64-encoded JSON envelope.
//
// On read, the wrapped DEK is unwrapped using the master key, then the
// ciphertext bytes from storage are decrypted with the DEK.
//
// Algorithm choices:
//   * AES-256-GCM for both wraps (DEK wrap + data encryption). GCM is the
//     standard authenticated-encryption mode in modern stacks; the master-
//     key-encrypt path already uses it elsewhere in the relay.
//   * 12-byte random IV per encryption (96 bits — GCM's recommended size).
//   * 16-byte GCM tag (default).
//
// Trust model — what this defends against:
//   * Storage backend compromise without relay compromise. An attacker
//     who reads the raw blob bytes from object storage cannot decrypt
//     them without the master key.
//   * Self-host filesystem snooping. Same property: the bytes on disk
//     are ciphertext.
//
// What this does NOT defend against:
//   * Relay compromise. If the attacker has the master key, every blob
//     is readable. (Customer-managed keys / HSM are v2.)
//   * Master-key rotation. v1 uses a single static master; rotating it
//     would orphan every existing wrapped DEK. (Rotation tool is v2.)

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypted-at-rest envelope, persisted as a JSON object in the
 * `encryption_envelope` column of the blob row. Fields are base64-encoded
 * binary; `v` is the envelope version and is the seam for future schemes
 * (CMK, key rotation, larger ciphers, etc.).
 */
export interface BlobEncryptionEnvelope {
  /** Envelope schema version. v=1 = AES-256-GCM master wrap + AES-256-GCM data. */
  v: 1;
  /** Wrapped data-encryption-key. `<12-byte IV><16-byte tag><32-byte ciphertext>`, base64. */
  wd: string;
  /** Data-encryption IV. 12 bytes, base64. */
  di: string;
  /** Data-encryption GCM tag. 16 bytes, base64. */
  dt: string;
}

/**
 * Encrypt `plaintext` with a freshly-generated DEK, wrap the DEK under the
 * master key, and return both the ciphertext and the persistable envelope.
 * The envelope must be stored next to the ciphertext (in the Blob row).
 *
 * The caller resolves the master key (via `crypto.getMasterKey()` in the
 * relay context) — keeps the relay's existing key-loading logic in one
 * place and lets tests inject a deterministic key.
 */
export function encryptBlob(
  plaintext: Buffer,
  master: Buffer,
): { ciphertext: Buffer; envelope: BlobEncryptionEnvelope } {
  const dek = randomBytes(32);

  // Wrap the DEK under the master key.
  const wIv = randomBytes(12);
  const wCipher = createCipheriv("aes-256-gcm", master, wIv);
  const wCipherText = Buffer.concat([wCipher.update(dek), wCipher.final()]);
  const wTag = wCipher.getAuthTag();
  const wrappedDek = Buffer.concat([wIv, wTag, wCipherText]);

  // Encrypt the data under the DEK.
  const dIv = randomBytes(12);
  const dCipher = createCipheriv("aes-256-gcm", dek, dIv);
  const ciphertext = Buffer.concat([
    dCipher.update(plaintext),
    dCipher.final(),
  ]);
  const dTag = dCipher.getAuthTag();

  return {
    ciphertext,
    envelope: {
      v: 1,
      wd: wrappedDek.toString("base64"),
      di: dIv.toString("base64"),
      dt: dTag.toString("base64"),
    },
  };
}

/**
 * Inverse of `encryptBlob`. Unwraps the DEK from `envelope.wd` using the
 * master key, then decrypts `ciphertext` using the DEK + envelope IV + tag.
 * Throws if either GCM authentication tag fails — the bytes have been
 * tampered with, or the wrong master key was used.
 */
export function decryptBlob(
  ciphertext: Buffer,
  envelope: BlobEncryptionEnvelope,
  master: Buffer,
): Buffer {
  if (envelope.v !== 1) {
    throw new Error(
      `unknown encryption envelope version: ${envelope.v} (this relay supports v=1)`,
    );
  }

  // Unwrap the DEK.
  const wrapped = Buffer.from(envelope.wd, "base64");
  const wIv = wrapped.subarray(0, 12);
  const wTag = wrapped.subarray(12, 28);
  const wCipherText = wrapped.subarray(28);
  const wDecipher = createDecipheriv("aes-256-gcm", master, wIv);
  wDecipher.setAuthTag(wTag);
  const dek = Buffer.concat([wDecipher.update(wCipherText), wDecipher.final()]);

  // Decrypt the data.
  const dIv = Buffer.from(envelope.di, "base64");
  const dTag = Buffer.from(envelope.dt, "base64");
  const dDecipher = createDecipheriv("aes-256-gcm", dek, dIv);
  dDecipher.setAuthTag(dTag);
  return Buffer.concat([dDecipher.update(ciphertext), dDecipher.final()]);
}

/**
 * Encode an envelope for persistence in the Blob row. We base64-wrap the
 * whole JSON object so the column can be a single TEXT field — the
 * three sub-fields are already base64 inside, but JSON-serialised they'd
 * include curly braces / quotes that complicate raw-SQL inspection.
 */
export function serialiseEnvelope(envelope: BlobEncryptionEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** Inverse of `serialiseEnvelope`. Throws on malformed input. */
export function parseEnvelope(raw: string): BlobEncryptionEnvelope {
  const json = Buffer.from(raw, "base64").toString("utf8");
  const parsed = JSON.parse(json) as Partial<BlobEncryptionEnvelope>;
  if (parsed.v !== 1 || !parsed.wd || !parsed.di || !parsed.dt) {
    throw new Error("malformed BlobEncryptionEnvelope");
  }
  return parsed as BlobEncryptionEnvelope;
}
