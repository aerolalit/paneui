import { createHash, randomBytes } from "node:crypto";

const API_KEY_PREFIX = "pane_";

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(16).toString("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function keyPrefix(value: string): string {
  return value.startsWith(API_KEY_PREFIX) ? value.slice(0, 11) : value.slice(0, 8);
}
