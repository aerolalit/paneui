import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

// AES-256-GCM envelope encryption for at-rest secrets (webhook callback secrets in v1).
// The master key is a 32-byte value loaded from PANE_SECRET_KEY (base64 or hex) or,
// for the zero-config self-host flow, generated and persisted to .pane-secret-key.
// The DB stores `v1.<iv-b64>.<ciphertext-b64>.<tag-b64>` so we can rotate algorithms later.

// Pin the key file to the project root (parent of src/ or dist/), not process.cwd(),
// so the server picks up the same key regardless of where it's launched from.
const KEY_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".pane-secret-key");
const FORMAT = "v1";

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // Hex (64 chars) or base64 (44 chars with padding).
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const buf = Buffer.from(trimmed, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "PANE_SECRET_KEY must be 32 bytes (base64 or hex). Generate with: openssl rand -base64 32",
    );
  }
  return buf;
}

function loadOrCreateKey(envValue: string | undefined): Buffer {
  if (envValue && envValue.length > 0) {
    return decodeKey(envValue);
  }
  if (existsSync(KEY_FILE)) {
    return decodeKey(readFileSync(KEY_FILE, "utf8"));
  }
  // First-boot self-host convenience: generate, persist 0600, warn.
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key.toString("base64") + "\n");
  try {
    chmodSync(KEY_FILE, 0o600);
  } catch {
    // best effort on platforms that don't support it
  }
  log.warn("PANE_SECRET_KEY not set; generated and persisted to .pane-secret-key", {
    path: KEY_FILE,
    note: "Back this file up. Losing it makes existing encrypted webhook secrets unreadable.",
  });
  return key;
}

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = loadOrCreateKey(process.env.PANE_SECRET_KEY);
  return cachedKey;
}

// For tests only.
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT, iv.toString("base64"), ct.toString("base64"), tag.toString("base64")].join(".");
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== FORMAT) {
    throw new Error("invalid encrypted secret format");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const ct = Buffer.from(parts[2]!, "base64");
  const tag = Buffer.from(parts[3]!, "base64");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return out.toString("utf8");
}

// Stable fingerprint of a secret for logging without leaking the secret itself.
export function secretFingerprint(blob: string): string {
  return createHash("sha256").update(blob).digest("hex").slice(0, 12);
}
