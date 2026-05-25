// /v1/self/* — human-authenticated routes for the logged-in human's
// own account. Requires the pane_login cookie via requireHuman.
//
//   POST /v1/self/claim-codes   mint a one-shot claim code; agent submits
//                               it to POST /v1/agents/claim to bind itself
//                               to this human (§6.1).
//
// Future Phase D will add /v1/self/profile, /v1/self/home-template, etc.

import { Hono } from "hono";
import { generateClaimCode, hashClaimCode } from "../../auth/claim.js";
import { keyPrefix } from "../../keys.js";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";

const self = new Hono<HumanAuthEnv>();

self.use("*", requireHuman);

// POST /v1/self/claim-codes
// Body: {} (none yet)
// Response: { code, code_prefix, expires_at }
//   - `code` is the RAW one-shot code; returned ONCE here and never again.
//     The human copies it and hands it to the agent out-of-band.
//   - `code_prefix` is a short, non-secret correlator for log lookups.
//
// The TTL is config.MAGIC_LINK_TTL_SECONDS for symmetry with the magic-link
// flow (both are short-lived one-shot codes the human is mid-transferring).
self.post("/claim-codes", async (c) => {
  const config = c.get("config");
  const prisma = c.get("prisma");
  const human = c.get("human");

  const code = generateClaimCode();
  const codeHash = hashClaimCode(code);
  const expiresAt = new Date(Date.now() + config.MAGIC_LINK_TTL_SECONDS * 1000);

  await prisma.claimCode.create({
    data: {
      humanId: human.id,
      codeHash,
      expiresAt,
    },
  });

  return c.json(
    {
      code,
      code_prefix: keyPrefix(code),
      expires_at: expiresAt.toISOString(),
    },
    201,
  );
});

export default self;
