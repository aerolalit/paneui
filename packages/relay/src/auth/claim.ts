// Claim codes for the agent-claim flow (§6.1).
//
// Token shape: `cc_<32-base64url>`. Stored as sha256(code) in the
// `claim_codes` table; the raw value is shown to the human once at mint
// time, then handed out-of-band to the agent which submits it to
// POST /v1/agents/claim.

import { randomBytes } from "node:crypto";
import { hashKey } from "../keys.js";

const CLAIM_CODE_PREFIX = "cc_";

export function generateClaimCode(): string {
  return CLAIM_CODE_PREFIX + randomBytes(24).toString("base64url");
}

export function hashClaimCode(code: string): string {
  return hashKey(code);
}
