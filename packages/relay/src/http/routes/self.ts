// /v1/self/* — human-authenticated routes for the logged-in human's
// own account. Requires the pane_login cookie via requireHuman.
//
//   POST /v1/self/claim-codes          mint a one-shot claim code; agent
//                                      submits it to POST /v1/agents/claim
//                                      to bind itself to this human (§6.1).
//   POST /v1/self/agents/:id/rotate-key  rotate the API key on an agent
//                                      owned by this human. Old key is
//                                      invalidated (key_hash overwritten);
//                                      the new key is returned ONCE.

import { Hono } from "hono";
import { generateClaimCode, hashClaimCode } from "../../auth/claim.js";
import { generateApiKey, hashKey, keyPrefix } from "../../keys.js";
import { errors } from "../errors.js";
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

// POST /v1/self/agents/:id/rotate-key
// Body: {} (none)
// Response: { agent_id, name, api_key, key_prefix, rotated_at }
//   - `api_key` is the RAW new key; returned ONCE here and never stored
//     in plaintext. The human copies it into the agent's config.
//   - The previous key is invalidated atomically: we overwrite the
//     agent row's key_hash + key_prefix with the new hash, so any
//     subsequent agent-authenticated request with the old key 401s.
//
// Authz: requireHuman (above) + the agent must be claimed by THIS human.
// A 404 (not a 403) is returned for an unclaimed-or-other-human agent so
// the route isn't an "is agent X claimed by anyone" oracle.
//
// Revoked agents (revokedAt != null) are NOT rotatable — that's a
// distinct lifecycle state from "lost the key". Surface explicitly so the
// human gets a useful error instead of a fresh key on a revoked row.
self.post("/agents/:id/rotate-key", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const agent = await prisma.agent.findFirst({
    where: { id, ownerHumanId: human.id, deletedAt: null },
    select: { id: true, name: true, revokedAt: true },
  });
  if (!agent) throw errors.notFound();
  if (agent.revokedAt) {
    throw errors.invalidRequest(
      "agent is revoked — rotating the key would not re-activate it",
      undefined,
      "unrevoke the agent first (or claim a fresh one) before rotating",
    );
  }

  const apiKey = generateApiKey();
  const newKeyHash = hashKey(apiKey);
  const newKeyPrefix = keyPrefix(apiKey);

  await prisma.agent.update({
    where: { id: agent.id },
    data: { keyHash: newKeyHash, keyPrefix: newKeyPrefix },
  });

  return c.json(
    {
      agent_id: agent.id,
      name: agent.name,
      api_key: apiKey,
      key_prefix: newKeyPrefix,
      rotated_at: new Date().toISOString(),
    },
    201,
  );
});

export default self;
