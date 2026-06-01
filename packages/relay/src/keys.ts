import { createHash, randomBytes } from "node:crypto";

const API_KEY_PREFIX = "pane_";
// Participant-token type prefixes: agent tokens carry "tok_a_", human tokens
// "tok_h_", so a stored tokenPrefix / log line is self-identifying.
const AGENT_TOKEN_PREFIX = "tok_a_";
const HUMAN_TOKEN_PREFIX = "tok_h_";
// Prefix length for display: include the "pane_" prefix plus 6 hex chars
// (11 total) for API keys. For participant tokens, include the full 6-char
// "tok_a_"/"tok_h_" type prefix plus 6 more chars (12 total) so the prefix is
// visible in the slice. Fallback (unprefixed/legacy values): 8 chars.
const API_KEY_PREFIX_LENGTH = 11;
const PARTICIPANT_TOKEN_PREFIX_LENGTH = 12;
const TOKEN_PREFIX_LENGTH = 8;

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(16).toString("hex");
}

export function generateAgentParticipantToken(): string {
  return AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function generateHumanParticipantToken(): string {
  return HUMAN_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

// Panes were historically called "sessions" — the wire-format prefix
// `pan_` matches the current vocabulary. Pre-rename rows still carry the
// old `pan_` prefix; IDs are opaque downstream so they continue to work.
export function generatePaneId(): string {
  return "pan_" + randomBytes(12).toString("base64url");
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function keyPrefix(value: string): string {
  if (value.startsWith(API_KEY_PREFIX)) {
    return value.slice(0, API_KEY_PREFIX_LENGTH);
  }
  if (
    value.startsWith(AGENT_TOKEN_PREFIX) ||
    value.startsWith(HUMAN_TOKEN_PREFIX)
  ) {
    return value.slice(0, PARTICIPANT_TOKEN_PREFIX_LENGTH);
  }
  return value.slice(0, TOKEN_PREFIX_LENGTH);
}
