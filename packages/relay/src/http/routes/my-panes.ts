// Cookie-authed pane lifecycle for the human-side owner shell.
//
//   DELETE /v1/my-panes/:id            soft-delete a pane the human owns
//   POST   /v1/my-panes/:id/favorite   star a pane (Home favorites strip)
//   DELETE /v1/my-panes/:id/favorite   unstar
//
// Parallels DELETE /v1/panes/:id (which is agent-authed) but lets the
// human delete from the owner-shell UI without minting an agent token.
// Restore + permanent-delete already live on /v1/my-trash.

import { Hono } from "hono";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import { errors } from "../errors.js";
import { log } from "../../log.js";

export const myPanes = new Hono<HumanAuthEnv>();

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
