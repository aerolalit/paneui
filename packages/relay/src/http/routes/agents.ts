// /v1/agents/* — agent-authenticated routes about the agent itself.
//
//   POST /v1/agents/claim   bind this agent to a human via a one-shot code
//                           the human generated via POST /v1/self/claim-codes
//                           (§6.1). Migrates ownership of all surfaces and
//                           templates the agent owns to the claiming human.

import { Hono } from "hono";
import { z } from "zod";
import { hashClaimCode } from "../../auth/claim.js";
import { requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";

const agents = new Hono<AuthEnv>();

agents.use("*", requireAgent);

// POST /v1/agents/claim
// Body: { code }
// Response: 200 { ok: true, owner_human_id, claimed_at }
//
// Errors:
//   400 invalid_request      — body shape wrong
//   400 invalid_code         — code unknown, expired, or already consumed
//   409 agent_already_claimed — this agent already has an owner_human_id
const claimBody = z.object({
  code: z.string().min(1).max(256),
});

agents.post("/claim", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");

  // Reject re-claim. Once an agent is owned, it stays owned (§6.3 — no
  // unclaim in v1; rotate by revoking + minting a new agent).
  if (agent.ownerHumanId) {
    return c.json(
      {
        error: {
          code: "agent_already_claimed",
          message: "this agent has already been claimed by a human",
        },
      },
      409,
    );
  }

  let body: z.infer<typeof claimBody>;
  try {
    body = claimBody.parse(await c.req.json());
  } catch {
    throw errors.invalidRequest("expected { code }");
  }
  const codeHash = hashClaimCode(body.code);

  const claim = await prisma.claimCode.findUnique({ where: { codeHash } });
  // Same error oracle as magic-link: treat missing / consumed / expired
  // identically to avoid telling a probe which it was.
  if (!claim || claim.consumedAt || claim.expiresAt < new Date()) {
    return c.json(
      {
        error: {
          code: "invalid_code",
          message: "claim code is invalid, expired, or already consumed",
        },
      },
      400,
    );
  }

  // Atomic consume + ownership migration in one transaction so a race
  // between two agents can't leave a half-claimed agent.
  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      // Step 1: atomic consume by sweeping consumedAt = NULL.
      const consumed = await tx.claimCode.updateMany({
        where: { id: claim.id, consumedAt: null },
        data: { consumedAt: now, consumedByAgentId: agent.id },
      });
      if (consumed.count === 0) {
        throw new Error("__RACE__");
      }
      // Step 2: bind the agent to the human.
      await tx.agent.update({
        where: { id: agent.id },
        data: { ownerHumanId: claim.humanId, claimedAt: now },
      });
      // Step 3: migrate ownership of the agent's surfaces from ownerAgentId
      // to ownerHumanId. ownerHumanId NULL on these rows by Phase A's
      // additive shape — set it to the claiming human. Leave ownerAgentId
      // alone too (so the audit trail still records the original agent
      // owner); the rule "ownerHumanId IS NOT NULL => human-owned" lets
      // Phase D's lookups treat the human as the new owner.
      //
      // NOTE: this writes ownerHumanId on EVERY surface/template the
      // agent owns. The proposal also describes flipping the ownership
      // model in Phase D (Surface.agentId removed); until then we just
      // tag the human owner alongside.
      await tx.surface.updateMany({
        where: { agentId: agent.id, ownerHumanId: null },
        data: { ownerHumanId: claim.humanId },
      });
      // Templates are agent-owned via Template.ownerId. Today there's no
      // human-ownership column on Template; auto-flow (§8.1) just joins
      // through Agent.ownerHumanId at query time, so no per-row write
      // is needed here. The agent's update above is enough.
    });
  } catch (err) {
    if (err instanceof Error && err.message === "__RACE__") {
      return c.json(
        {
          error: {
            code: "invalid_code",
            message: "claim code is invalid, expired, or already consumed",
          },
        },
        400,
      );
    }
    throw err;
  }

  return c.json({
    ok: true,
    owner_human_id: claim.humanId,
    claimed_at: now.toISOString(),
  });
});

export default agents;
