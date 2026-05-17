import { createHash, randomBytes } from "node:crypto";

const API_KEY_PREFIX = "pane_";
// Prefix length for display: include the "pane_" prefix plus 6 hex chars (11 total)
// for API keys, or 8 hex chars for participant tokens.
const API_KEY_PREFIX_LENGTH = 11;
const TOKEN_PREFIX_LENGTH = 8;

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(16).toString("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateSessionId(): string {
  return "ses_" + randomBytes(12).toString("base64url");
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function keyPrefix(value: string): string {
  return value.startsWith(API_KEY_PREFIX)
    ? value.slice(0, API_KEY_PREFIX_LENGTH)
    : value.slice(0, TOKEN_PREFIX_LENGTH);
}
