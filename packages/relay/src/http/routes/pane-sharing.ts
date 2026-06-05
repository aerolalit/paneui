// Pane sharing management — agent-authed (the CLI's `pane share` entry point).
//
//   PATCH  /v1/panes/:id/visibility   toggle isPublic { is_public: bool }
//   GET    /v1/panes/:id/grants        list identity-share grants
//   POST   /v1/panes/:id/grants        invite by email (upsert) { email, role? }
//   DELETE /v1/panes/:id/grants/:gid   revoke one grant (idempotent)
//
// Authz: same as every other pane *mutation* — requireAgent + assertPaneInScope
// (the pane must be in the calling agent's scope: owned by it or by an agent
// claimed to the same human). This is the surface the CLI hits with the agent
// key. The human-side owner shell will add its own cookie-authed Share dialog
// in a follow-up; both will converge on these grant rows.
//
// Visibility lives at /:id/visibility (not a bare PATCH /:id) so it slots
// cleanly beside the existing /:id/participants + /:id/upgrade sub-routes and
// doesn't fight the agent-CRUD PATCH conventions elsewhere.

import { Hono } from "hono";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireAgent, type AuthEnv } from "../auth.js";
import { assertPaneInScope } from "./panes.js";
import { normalizeEmail } from "../../auth/magic-link.js";
import { errors } from "../errors.js";

const paneSharing = new Hono<AuthEnv>();

// Load the pane (scope fields only) and assert it's in the caller's scope.
// Throws the same sessionNotFound / forbidden shapes the agent-CRUD routes
// use, so this route is no different an oracle than POST /:id/participants.
async function loadInScope(
  prisma: PrismaClient,
  paneId: string,
  me: { id: string; ownerHumanId: string | null },
) {
  const pane = await prisma.pane.findUnique({
    where: { id: paneId },
    select: { id: true, agentId: true, ownerHumanId: true, isPublic: true },
  });
  return assertPaneInScope(prisma, pane, me);
}

// PATCH /v1/panes/:id/visibility — toggle the pane's public visibility.
const visibilityBody = z.object({
  is_public: z.boolean(),
});

paneSharing.patch("/:id/visibility", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");
  const id = c.req.param("id");

  const parsed = visibilityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid visibility update",
      parsed.error.flatten(),
      "send { is_public: boolean }",
    );
  }

  const pane = await loadInScope(prisma, id, me);
  await prisma.pane.update({
    where: { id: pane.id },
    data: { isPublic: parsed.data.is_public },
  });

  return c.json({ pane_id: pane.id, is_public: parsed.data.is_public });
});

// GET /v1/panes/:id/grants — list every grant on the pane.
paneSharing.get("/:id/grants", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");
  const id = c.req.param("id");

  const pane = await loadInScope(prisma, id, me);
  const grants = await prisma.paneGrant.findMany({
    where: { paneId: pane.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      humanId: true,
      inviteEmail: true,
      role: true,
      acceptedAt: true,
    },
  });

  return c.json({
    pane_id: pane.id,
    is_public: pane.isPublic,
    items: grants.map((g) => ({
      id: g.id,
      human_id: g.humanId,
      invite_email: g.inviteEmail,
      role: g.role,
      accepted_at: g.acceptedAt ? g.acceptedAt.toISOString() : null,
    })),
  });
});

// POST /v1/panes/:id/grants — invite by email. Upsert keyed on
// (paneId, inviteEmail) so re-inviting the same address updates the role
// instead of erroring or duplicating. Role defaults to "participant".
const createGrantBody = z.object({
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().email().max(320),
  ),
  role: z.enum(["participant", "viewer"]).optional(),
});

paneSharing.post("/:id/grants", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");
  const id = c.req.param("id");

  const parsed = createGrantBody.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid grant",
      parsed.error.flatten(),
      "send { email: string, role?: 'participant' | 'viewer' }",
    );
  }

  const pane = await loadInScope(prisma, id, me);
  const email = normalizeEmail(parsed.data.email);
  const role = parsed.data.role ?? "participant";

  // invitedBy is the pane's owning human when known; standalone (unclaimed)
  // agents have no human owner, so fall back to the agent id as the granter
  // anchor. The column is audit-only — access flows from the grant role.
  const invitedBy = pane.ownerHumanId ?? me.id;

  // If the invitee already has a bound grant (humanId set) — e.g. they logged
  // in earlier — update that row by (paneId, humanId). Otherwise upsert the
  // pending row by (paneId, inviteEmail). We resolve the human first so a
  // re-invite of an already-accepted grantee adjusts their role in place.
  const existingHuman = await prisma.human.findUnique({
    where: { email },
    select: { id: true },
  });
  const boundGrant = existingHuman
    ? await prisma.paneGrant.findUnique({
        where: {
          paneId_humanId: { paneId: pane.id, humanId: existingHuman.id },
        },
        select: { id: true },
      })
    : null;

  let grant;
  if (boundGrant) {
    grant = await prisma.paneGrant.update({
      where: { id: boundGrant.id },
      data: { role, inviteEmail: email },
      select: {
        id: true,
        humanId: true,
        inviteEmail: true,
        role: true,
        acceptedAt: true,
      },
    });
  } else {
    grant = await prisma.paneGrant.upsert({
      where: { paneId_inviteEmail: { paneId: pane.id, inviteEmail: email } },
      create: {
        paneId: pane.id,
        inviteEmail: email,
        role,
        invitedBy,
        // Bind immediately if the invitee already has a (verified or not)
        // Human row — saves a round-trip; the magic-link path also binds.
        ...(existingHuman
          ? { humanId: existingHuman.id, acceptedAt: new Date() }
          : {}),
      },
      update: { role },
      select: {
        id: true,
        humanId: true,
        inviteEmail: true,
        role: true,
        acceptedAt: true,
      },
    });
  }

  return c.json(
    {
      id: grant.id,
      human_id: grant.humanId,
      invite_email: grant.inviteEmail,
      role: grant.role,
      accepted_at: grant.acceptedAt ? grant.acceptedAt.toISOString() : null,
    },
    201,
  );
});

// DELETE /v1/panes/:id/grants/:gid — revoke one grant. Idempotent: a missing
// or already-removed grant returns 204 (the caller's intent is satisfied).
paneSharing.delete("/:id/grants/:gid", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");
  const id = c.req.param("id");
  const gid = c.req.param("gid");

  const pane = await loadInScope(prisma, id, me);
  // Scope the delete to (id, paneId) so a grant id from another pane can't be
  // removed via this pane's id.
  await prisma.paneGrant.deleteMany({
    where: { id: gid, paneId: pane.id },
  });

  return c.body(null, 204);
});

export default paneSharing;
