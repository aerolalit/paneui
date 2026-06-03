// Cookie-authed pane lifecycle for the human-side owner shell.
//
//   DELETE /v1/my-panes/:id   soft-delete a pane the human owns
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
