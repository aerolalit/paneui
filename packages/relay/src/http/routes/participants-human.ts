// Human-authenticated participant minting (§7.3 — two invitation modes).
//
//   POST /v1/surfaces/:id/identity-link  identity-bound human participant
//                                         (Alice mints a URL only bob can use;
//                                         was /invite-email pre-#261)
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
import type { PrismaClient } from "@prisma/client";
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

// Mint a kind="human" Participant on a surface, retrying on the
// (surfaceId, identityId) unique-constraint collision a concurrent mint can
// cause. The identityId is allocated monotonically from the ever-minted human
// count (matching the agent-side allocator in routes/surfaces.ts); two
// concurrent invites that both read the same count and pick the same `h_${N}`
// see P2002 on the loser, which then loops back, re-reads the count, and
// picks the next index. Without this, both identity-link and public-link
// would 500 under realistic concurrency (the comment used to say "we retry on
// conflict" but the retry was never actually wired up).
async function mintHumanParticipantWithRetry(args: {
  prisma: PrismaClient;
  surfaceId: string;
  tokenHash: string;
  tokenPrefix: string;
  humanId?: string;
}): Promise<{ id: string; identityId: string; tokenPrefix: string }> {
  const { prisma, surfaceId, tokenHash, tokenPrefix, humanId } = args;
  // Cap the retry budget. Each round wins or loses one identity-id slot, so
  // the worst case bounded by "at most N concurrent racers each running to
  // exhaustion against each other" — pegging this at 8 covers any realistic
  // owner-side burst (clicking Invite twice fast in two tabs).
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const everCount = await prisma.participant.count({
      where: { surfaceId, kind: "human" },
    });
    try {
      return await prisma.participant.create({
        data: {
          surfaceId,
          kind: "human",
          identityId: `h_${everCount}`,
          tokenHash,
          tokenPrefix,
          ...(humanId ? { humanId } : {}),
        },
        select: { id: true, identityId: true, tokenPrefix: true },
      });
    } catch (e) {
      // Narrow to (surfaceId, identityId) collisions; let other P2002s
      // (e.g. tokenHash) bubble — those signal a real bug. See
      // routes/surfaces.ts (POST /:id/participants) for the matching shape.
      const code = (e as { code?: string } | null)?.code;
      if (code !== "P2002" || attempt === MAX_ATTEMPTS - 1) throw e;
      const target = (e as { meta?: { target?: unknown } } | null)?.meta
        ?.target;
      const targetStr = Array.isArray(target)
        ? target.join(",")
        : String(target ?? "");
      const message = (e as { message?: string } | null)?.message ?? "";
      const isIdentityCollision =
        targetStr.includes("identity_id") ||
        targetStr.includes("participants_session_id_identity_id_key") ||
        message.includes("identity_id");
      if (!isIdentityCollision) throw e;
    }
  }
  throw new Error("could not allocate participant identity-id after retries");
}

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
// POST /v1/surfaces/:id/identity-link
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
//   - returns the surface URL ONCE; bob must complete the cookie flow on
//     first visit
// ----------------------------------------------------------------------
const identityLinkBody = z.object({
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().email().max(320),
  ),
});

participantsHuman.post("/:id/identity-link", async (c) => {
  const surface = await loadOwnedSurface(c);
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
  // mirrors agent-side mints: `h_${count}`. The (surfaceId, identityId)
  // unique constraint serialises concurrent inserts; we retry on conflict
  // (the helper below mirrors the agent-side mint loop in
  // src/http/routes/surfaces.ts — same shape, same constraint).
  //
  // Note: the relay deliberately accepts multiple identity-bound
  // participants for the same human on the same surface (the owner can
  // mint several revocable invite URLs for one person). So we only dedup
  // on identityId collisions — not on (surfaceId, humanId) — and let the
  // counter drive a fresh slot each call.
  const token = generateHumanParticipantToken();
  const tokenHash = hashKey(token);
  const tokenPrefix_ = keyPrefix(token);
  const participant = await mintHumanParticipantWithRetry({
    prisma,
    surfaceId: surface.id,
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
  // humanId omitted — this is an anonymous capability participant.
  const participant = await mintHumanParticipantWithRetry({
    prisma,
    surfaceId: surface.id,
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
