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
// key. The human-side owner shell drives the SAME grant rows through the
// cookie-authed /v1/my-panes/:id/{visibility,grants} routes (routes/my-panes.ts).
//
// Both surfaces share one implementation: the grant + visibility DB ops and
// their zod validation live in pane-sharing-service.ts, so this route and the
// human route can never drift on what an invite / visibility change does.
//
// Visibility lives at /:id/visibility (not a bare PATCH /:id) so it slots
// cleanly beside the existing /:id/participants + /:id/upgrade sub-routes and
// doesn't fight the agent-CRUD PATCH conventions elsewhere.

import { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { requireAgent, type AuthEnv } from "../auth.js";
import { assertPaneInScope } from "./panes.js";
import { errors } from "../errors.js";
import {
  visibilityBody,
  createGrantBody,
  setVisibility,
  listGrantsAndVisibility,
  createGrant,
  deleteGrant,
} from "./pane-sharing-service.js";

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
  await setVisibility(prisma, pane.id, parsed.data.is_public);

  return c.json({ pane_id: pane.id, is_public: parsed.data.is_public });
});

// GET /v1/panes/:id/grants — list every grant on the pane.
paneSharing.get("/:id/grants", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");
  const id = c.req.param("id");

  const pane = await loadInScope(prisma, id, me);
  const { isPublic, grants } = await listGrantsAndVisibility(prisma, pane.id);

  return c.json({
    pane_id: pane.id,
    is_public: isPublic,
    items: grants,
  });
});

// POST /v1/panes/:id/grants — invite by email. Upsert keyed on
// (paneId, inviteEmail) so re-inviting the same address updates the role
// instead of erroring or duplicating. Role defaults to "participant".
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
  // invitedBy is the pane's owning human when known; standalone (unclaimed)
  // agents have no human owner, so fall back to the agent id as the granter
  // anchor. The column is audit-only — access flows from the grant role.
  const invitedBy = pane.ownerHumanId ?? me.id;
  const grant = await createGrant(prisma, pane.id, parsed.data, invitedBy);

  return c.json(grant, 201);
});

// DELETE /v1/panes/:id/grants/:gid — revoke one grant. Idempotent: a missing
// or already-removed grant returns 204 (the caller's intent is satisfied).
paneSharing.delete("/:id/grants/:gid", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");
  const id = c.req.param("id");
  const gid = c.req.param("gid");

  const pane = await loadInScope(prisma, id, me);
  await deleteGrant(prisma, pane.id, gid);

  return c.body(null, 204);
});

export default paneSharing;
