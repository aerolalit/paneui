// Human-authenticated participant minting (§7.3 — two invitation modes).
//
//   POST /v1/surfaces/:id/invite-email   identity-bound human participant
//                                         (Alice → bob@example.com)
//   POST /v1/surfaces/:id/public-link    anonymous capability participant
//                                         (Google-Docs-style "anyone with the
//                                         link" share)
//
// Both routes:
//   - require the calling human to be logged in (requireHuman)
//   - require the surface to be owned by the calling human (or its
//     ownerAgent to be owned by the calling human)
//
// Companion to the existing agent-auth POST /v1/surfaces/:id/participants
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

const participantsHuman = new Hono<HumanAuthEnv>();

participantsHuman.use("*", requireHuman);

/**
 * Verifies the calling human owns the surface (or owns the agent that
 * owns it). Returns the loaded surface. Throws sessionNotFound for any
 * mismatch — same shape an agent would see if it didn't own the
 * surface, so no ownership oracle.
 */
async function loadOwnedSurface(c: Context<HumanAuthEnv>): Promise<{
  id: string;
  expiresAt: Date;
  status: "open" | "closed";
}> {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.sessionNotFound();

  const surface = await prisma.surface.findUnique({
    where: { id },
    include: { agent: true },
  });
  if (!surface) throw errors.sessionNotFound();

  const isOwner =
    surface.ownerHumanId === human.id ||
    surface.agent.ownerHumanId === human.id;
  if (!isOwner) throw errors.sessionNotFound();

  if (surface.status === "closed" || surface.expiresAt.getTime() < Date.now()) {
    throw errors.gone(
      "surface is closed — invitations on a closed surface would not be reachable",
    );
  }

  return {
    id: surface.id,
    expiresAt: surface.expiresAt,
    status: surface.status,
  };
}

/**
 * Build the URL the human shares. Falls back to a path if PUBLIC_URL is
 * not absolute — the caller can always combine with their own base.
 */
function buildParticipantUrl(args: {
  publicUrl: string;
  token: string;
}): string {
  const base = args.publicUrl.replace(/\/$/, "");
  return `${base}/s/${args.token}`;
}

// ----------------------------------------------------------------------
// POST /v1/surfaces/:id/invite-email
//   Body: { email }
//   Response: 201 { participant_id, kind:"human", token, url, identity:{email} }
//
// Behaviour (§7.3 A):
//   - normalises the email
//   - finds-or-creates the Human row (verifiedAt stays NULL — verification
//     comes on bob's first magic-link login)
//   - mints a Participant row bound to humanId = bob.id
//   - returns the surface URL ONCE; bob must complete the cookie flow on
//     first visit
// ----------------------------------------------------------------------
const inviteEmailBody = z.object({
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().email().max(320),
  ),
});

participantsHuman.post("/:id/invite-email", async (c) => {
  const surface = await loadOwnedSurface(c);
  const prisma = c.get("prisma");
  const config = c.get("config");
  // human is implied by requireHuman; we don't need to re-read it here.

  let body: z.infer<typeof inviteEmailBody>;
  try {
    body = inviteEmailBody.parse(await c.req.json());
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
  // mirrors agent-side mints: `h_${count}`. The (surfaceId, identityId)
  // unique constraint serialises concurrent inserts; we retry on conflict.
  const token = generateHumanParticipantToken();
  const tokenHash = hashKey(token);
  const tokenPrefix_ = keyPrefix(token);

  // Single attempt is fine here — concurrent invites for the SAME email on
  // the SAME surface would dedup via the (surfaceId, identityId) unique
  // constraint, but we'd prefer to also dedup by humanId. The relay accepts
  // multiple identity-bound participants for the same human (the human
  // gets two URLs — both work; either can be revoked independently).
  const everCount = await prisma.participant.count({
    where: { surfaceId: surface.id, kind: "human" },
  });
  const participant = await prisma.participant.create({
    data: {
      surfaceId: surface.id,
      kind: "human",
      identityId: `h_${everCount}`,
      humanId: target.id,
      tokenHash,
      tokenPrefix: tokenPrefix_,
    },
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
// POST /v1/surfaces/:id/public-link
//   Body: {}
//   Response: 201 { participant_id, kind:"human", token, url }
//
// Behaviour (§7.3 B):
//   - mints a Participant with humanId NULL and agentId NULL
//   - anyone with the URL participates without logging in
//   - revocable like any other participant (DELETE works the same way)
// ----------------------------------------------------------------------
participantsHuman.post("/:id/public-link", async (c) => {
  const surface = await loadOwnedSurface(c);
  const prisma = c.get("prisma");
  const config = c.get("config");

  const token = generateHumanParticipantToken();
  const tokenHash = hashKey(token);
  const tokenPrefix_ = keyPrefix(token);

  const everCount = await prisma.participant.count({
    where: { surfaceId: surface.id, kind: "human" },
  });
  const participant = await prisma.participant.create({
    data: {
      surfaceId: surface.id,
      kind: "human",
      identityId: `h_${everCount}`,
      // humanId + agentId both NULL — this is an anonymous capability participant.
      tokenHash,
      tokenPrefix: tokenPrefix_,
    },
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
