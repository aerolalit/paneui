// Human-authenticated participant minting (§7.3 — two invitation modes).
//
//   POST /v1/panes/:id/identity-link  identity-bound human participant
//                                         (Alice mints a URL only bob can use;
//                                         was /invite-email pre-#261)
//   POST /v1/panes/:id/public-link    anonymous capability participant
//                                         (Google-Docs-style "anyone with the
//                                         link" share)
//
// Both routes:
//   - require the calling human to be logged in (requireHuman)
//   - require the pane to be owned by the calling human (or its
//     ownerAgent to be owned by the calling human)
//
// Companion to the existing agent-auth POST /v1/panes/:id/participants
// (which mints anonymous capability participants on behalf of the agent).

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  generateHumanParticipantToken,
  hashKey,
  keyPrefix,
} from "../../keys.js";
import { normalizeEmail } from "../../auth/magic-link.js";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import { errors } from "../errors.js";
import {
  mintHumanParticipantWithRetry,
  buildParticipantUrl,
} from "./human-participant-mint.js";

const participantsHuman = new Hono<HumanAuthEnv>();

participantsHuman.use("*", requireHuman);

/**
 * Verifies the calling human owns the pane (or owns the agent that
 * owns it). Returns the loaded pane. Throws paneNotFound for any
 * mismatch — same shape an agent would see if it didn't own the
 * pane, so no ownership oracle.
 */
async function loadOwnedPane(c: Context<HumanAuthEnv>): Promise<{
  id: string;
  expiresAt: Date;
  status: "open" | "closed";
}> {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.paneNotFound();

  const pane = await prisma.pane.findUnique({
    where: { id },
    include: { agent: true },
  });
  if (!pane) throw errors.paneNotFound();

  const isOwner =
    pane.ownerHumanId === human.id || pane.agent.ownerHumanId === human.id;
  if (!isOwner) throw errors.paneNotFound();

  if (pane.status === "closed" || pane.expiresAt.getTime() < Date.now()) {
    throw errors.gone(
      "pane is closed — invitations on a closed pane would not be reachable",
    );
  }

  return {
    id: pane.id,
    expiresAt: pane.expiresAt,
    status: pane.status,
  };
}

// ----------------------------------------------------------------------
// POST /v1/panes/:id/identity-link
//
// Was /invite-email until #261 — the old name read as an action verb
// ("email an invitation to bob") but the endpoint doesn't send mail; it
// mints + returns a URL the owner delivers out-of-band. /identity-link
// parallels /public-link below: both routes mint a Participant URL,
// but /identity-link binds the URL to a specific human (only that human
// can use it after logging in), while /public-link is anyone-with-the-URL.
// No legacy alias — the renamer accepts the break (only direct API
// callers are affected today; no UI shell or CLI consumed the old path).
//
//   Body: { email }
//   Response: 201 { participant_id, kind:"human", token, url, identity:{email} }
//
// Behaviour (§7.3 A):
//   - normalises the email
//   - finds-or-creates the Human row (verifiedAt stays NULL — verification
//     comes on bob's first magic-link login)
//   - mints a Participant row bound to humanId = bob.id
//   - returns the pane URL ONCE; bob must complete the cookie flow on
//     first visit
// ----------------------------------------------------------------------
const identityLinkBody = z.object({
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().email().max(320),
  ),
});

participantsHuman.post("/:id/identity-link", async (c) => {
  const pane = await loadOwnedPane(c);
  const prisma = c.get("prisma");
  const config = c.get("config");
  // human is implied by requireHuman; we don't need to re-read it here.

  let body: z.infer<typeof identityLinkBody>;
  try {
    body = identityLinkBody.parse(await c.req.json());
  } catch {
    throw errors.invalidRequest("expected { email }");
  }
  const email = normalizeEmail(body.email);

  // Find-or-create the target Human. verifiedAt stays null until bob's
  // first successful magic-link login.
  const target = await prisma.human.upsert({
    where: { email },
    create: { email },
    update: {},
  });

  // Mint the identity-bound participant. The identityId convention here
  // mirrors agent-side mints: `h_${count}`. The (paneId, identityId)
  // unique constraint serialises concurrent inserts; we retry on conflict
  // (the helper below mirrors the agent-side mint loop in
  // src/http/routes/panes.ts — same shape, same constraint).
  //
  // Note: the relay deliberately accepts multiple identity-bound
  // participants for the same human on the same pane (the owner can
  // mint several revocable invite URLs for one person). So we only dedup
  // on identityId collisions — not on (paneId, humanId) — and let the
  // counter drive a fresh slot each call.
  const token = generateHumanParticipantToken();
  const tokenHash = hashKey(token);
  const tokenPrefix_ = keyPrefix(token);
  const participant = await mintHumanParticipantWithRetry({
    prisma,
    paneId: pane.id,
    humanId: target.id,
    tokenHash,
    tokenPrefix: tokenPrefix_,
  });

  return c.json(
    {
      participant_id: participant.id,
      kind: "human",
      identity: { email },
      token,
      url: buildParticipantUrl({ publicUrl: config.publicUrl, token }),
      token_prefix: participant.tokenPrefix,
    },
    201,
  );
});

// ----------------------------------------------------------------------
// POST /v1/panes/:id/public-link
//   Body: {}
//   Response: 201 { participant_id, kind:"human", token, url }
//
// Behaviour (§7.3 B):
//   - mints a Participant with humanId NULL and agentId NULL
//   - anyone with the URL participates without logging in
//   - revocable like any other participant (DELETE works the same way)
// ----------------------------------------------------------------------
participantsHuman.post("/:id/public-link", async (c) => {
  const pane = await loadOwnedPane(c);
  const prisma = c.get("prisma");
  const config = c.get("config");

  const token = generateHumanParticipantToken();
  const tokenHash = hashKey(token);
  const tokenPrefix_ = keyPrefix(token);
  // humanId omitted — this is an anonymous capability participant.
  const participant = await mintHumanParticipantWithRetry({
    prisma,
    paneId: pane.id,
    tokenHash,
    tokenPrefix: tokenPrefix_,
  });

  return c.json(
    {
      participant_id: participant.id,
      kind: "human",
      token,
      url: buildParticipantUrl({ publicUrl: config.publicUrl, token }),
      token_prefix: participant.tokenPrefix,
    },
    201,
  );
});

export default participantsHuman;
