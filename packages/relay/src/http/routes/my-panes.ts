// Cookie-authed pane lifecycle for the human-side owner shell.
//
//   DELETE /v1/my-panes/:id              soft-delete a pane the human owns
//   POST   /v1/my-panes/:id/favorite     star a pane (Home favorites strip)
//   DELETE /v1/my-panes/:id/favorite     unstar
//   GET    /v1/my-panes/:id/grants       list grants + visibility (Share dialog)
//   POST   /v1/my-panes/:id/grants       invite by email { email, role? }
//   DELETE /v1/my-panes/:id/grants/:gid  revoke a grant
//   PATCH  /v1/my-panes/:id/visibility   { access_mode } set the /p access mode
//   POST   /v1/my-panes/:id/share-link   mint a default /s/<token> share link
//
// Parallels DELETE /v1/panes/:id (which is agent-authed) but lets the
// human delete from the owner-shell UI without minting an agent token.
// Restore + permanent-delete already live on /v1/my-trash.
//
// The grant + visibility routes are the cookie-authed twin of the agent-authed
// /v1/panes/:id/{grants,visibility} surface (routes/pane-sharing.ts). Both call
// the SAME DB ops + zod schemas (pane-sharing-service.ts) so #436's invite /
// visibility logic is reused, not duplicated; the only difference is the authz
// gate (ownerHumanId === human.id, 404 no-oracle vs. agent scope). These routes
// inherit the /v1/my-panes/* CSRF Origin check wired in app.ts, so the owner
// shell's same-origin fetches pass while a cross-site POST is refused.

import { Hono, type Context } from "hono";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import { errors } from "../errors.js";
import { log } from "../../log.js";
import {
  generateHumanParticipantToken,
  hashKey,
  keyPrefix,
} from "../../keys.js";
import {
  visibilityBody,
  createGrantBody,
  setVisibility,
  listGrantsAndVisibility,
  createGrant,
  deleteGrant,
} from "./pane-sharing-service.js";
import {
  mintHumanParticipantWithRetry,
  buildParticipantUrl,
} from "./human-participant-mint.js";

export const myPanes = new Hono<HumanAuthEnv>();

// Load a pane and assert the calling human OWNS it (ownerHumanId == human.id).
// Returns the minimal pane row. Throws notFound() for a missing OR not-owned
// pane — same 404 shape as the rest of /my-* so the route is no "does this
// pane id exist" oracle. Soft-deleted panes 404 too (a trashed pane shouldn't
// be shareable). Used by the Share-dialog routes below.
async function loadOwnedPaneForShare(
  c: Context<HumanAuthEnv>,
): Promise<{ id: string }> {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.notFound();

  const pane = await prisma.pane.findUnique({
    where: { id },
    select: { id: true, ownerHumanId: true, deletedAt: true },
  });
  if (!pane || pane.ownerHumanId !== human.id || pane.deletedAt !== null) {
    throw errors.notFound();
  }
  return { id: pane.id };
}

// DELETE /v1/my-panes/:id
//
// The pane must be owned by the calling human (ownerHumanId == human.id).
// Same 404-on-not-found / not-owned shape used by /my-templates so we
// don't leak whether someone else's pane id exists.
//
// Soft-delete only: sets deletedAt + writes an audit row. The hard-delete
// path stays on /v1/my-trash/panes/:id (and the relay's sweeper).
myPanes.delete("/:id", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing pane id");

  const pane = await prisma.pane.findUnique({
    where: { id },
    select: {
      id: true,
      ownerHumanId: true,
      agentId: true,
      deletedAt: true,
    },
  });
  if (!pane || pane.ownerHumanId !== human.id) {
    throw errors.notFound();
  }
  if (pane.deletedAt !== null) {
    // Idempotent — already trashed, treat as success.
    return c.body(null, 204);
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.pane.update({
      where: { id },
      data: { deletedAt: now },
    }),
    prisma.deletionLog.create({
      data: {
        entityType: "pane",
        entityId: id,
        ownerHumanId: human.id,
        ownerAgentId: pane.agentId,
        phase: "soft_deleted",
        reason: "human_delete",
        at: now,
      },
    }),
  ]);

  log.info("my-panes: soft-deleted", { paneId: id, humanId: human.id });
  return c.body(null, 204);
});

// POST /v1/my-panes/:id/favorite — star a pane for the calling human.
//
// Visibility check: the human must own the pane OR be an active participant.
// We don't leak existence of unrelated panes — same 404 shape as the rest of
// /my-* routes. Idempotent: starring twice writes one row.
myPanes.post("/:id/favorite", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing pane id");

  const pane = await prisma.pane.findUnique({
    where: { id },
    select: {
      id: true,
      ownerHumanId: true,
      deletedAt: true,
      participants: {
        where: { humanId: human.id, revokedAt: null },
        select: { id: true },
      },
    },
  });
  const isOwner = pane && pane.ownerHumanId === human.id;
  const isParticipant = pane && pane.participants.length > 0;
  if (!pane || pane.deletedAt !== null || (!isOwner && !isParticipant)) {
    throw errors.notFound();
  }

  await prisma.humanPaneFavorite.upsert({
    where: { humanId_paneId: { humanId: human.id, paneId: id } },
    create: { humanId: human.id, paneId: id },
    update: {},
  });

  return c.json({ id, favorited: true });
});

// DELETE /v1/my-panes/:id/favorite — unstar. Idempotent on missing rows.
myPanes.delete("/:id/favorite", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing pane id");

  await prisma.humanPaneFavorite.deleteMany({
    where: { humanId: human.id, paneId: id },
  });

  return c.body(null, 204);
});

// ----------------------------------------------------------------------
// Share dialog — cookie-authed grant + visibility management. Owner-only;
// every route 404s a non-owned/missing pane (no existence oracle) and is
// CSRF-protected (the /v1/my-panes/* mount, app.ts). All DB work + validation
// is the shared pane-sharing-service so the agent surface and this one agree.
// ----------------------------------------------------------------------

// GET /v1/my-panes/:id/grants — current visibility + every grant on the pane.
// Powers the Share dialog's initial render.
myPanes.get("/:id/grants", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const pane = await loadOwnedPaneForShare(c);
  const { accessMode, grants } = await listGrantsAndVisibility(prisma, pane.id);
  return c.json({ pane_id: pane.id, access_mode: accessMode, items: grants });
});

// POST /v1/my-panes/:id/grants — invite by email. Role defaults to participant.
myPanes.post("/:id/grants", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const pane = await loadOwnedPaneForShare(c);

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

  // The owner (the logged-in human) is the audit anchor for invitedBy.
  const grant = await createGrant(prisma, pane.id, parsed.data, human.id);
  return c.json(grant, 201);
});

// DELETE /v1/my-panes/:id/grants/:gid — revoke a grant. Idempotent.
myPanes.delete("/:id/grants/:gid", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const pane = await loadOwnedPaneForShare(c);
  const gid = c.req.param("gid");
  if (!gid) throw errors.notFound();
  await deleteGrant(prisma, pane.id, gid);
  return c.body(null, 204);
});

// PATCH /v1/my-panes/:id/visibility — set the /p access mode { access_mode }.
myPanes.patch("/:id/visibility", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const pane = await loadOwnedPaneForShare(c);

  const parsed = visibilityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid visibility update",
      parsed.error.flatten(),
      "send { access_mode: 'invite_only' | 'link' | 'public' }",
    );
  }

  await setVisibility(prisma, pane.id, parsed.data.access_mode);
  return c.json({ pane_id: pane.id, access_mode: parsed.data.access_mode });
});

// POST /v1/my-panes/:id/share-link — mint a default anonymous /s/<token>
// share link (the immediate-view, no-login "copy link" the dialog offers by
// default). Mirrors the human-authed POST /v1/panes/:id/public-link mint,
// reusing the same allocator helper; the only difference is the CSRF-protected
// /my-panes mount the owner shell already satisfies.
myPanes.post("/:id/share-link", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const pane = await loadOwnedPaneForShare(c);

  const token = generateHumanParticipantToken();
  const participant = await mintHumanParticipantWithRetry({
    prisma,
    paneId: pane.id,
    tokenHash: hashKey(token),
    tokenPrefix: keyPrefix(token),
    // humanId omitted — anonymous capability participant (anyone with the URL).
  });

  return c.json(
    {
      participant_id: participant.id,
      token,
      url: buildParticipantUrl({ publicUrl: config.publicUrl, token }),
      token_prefix: participant.tokenPrefix,
    },
    201,
  );
});
