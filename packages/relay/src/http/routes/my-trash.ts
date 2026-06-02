// #309 — /v1/my-trash: cookie-authed trash routes for the human UI.
//
//   GET    /v1/my-trash                       list everything in this human's trash
//   POST   /v1/my-trash/panes/:id/restore     clear deletedAt (un-trash)
//   POST   /v1/my-trash/templates/:id/restore likewise
//   DELETE /v1/my-trash/panes/:id             permanent hard-delete
//   DELETE /v1/my-trash/templates/:id         permanent hard-delete
//
// Mirrors the agent-authed /v1/trash routes (#306) but uses the pane_login
// cookie via `requireHuman`. Mounted at /v1/my-trash to avoid colliding with
// the agent path — same pattern as /v1/templates (agent) vs /v1/my-templates
// (human, see template-marketplace.ts:551).
//
// Ownership scope for a human:
//   - Panes: row.ownerHumanId === human.id  OR  row.agent.ownerHumanId === human.id
//   - Templates: template.owner.ownerHumanId === human.id
//
// Existence-oracle parity with #306: missing / not-mine / not-in-trash all
// resolve to 404; only the live-pane-references conflict on template purge
// returns a distinguishable status.

import { Hono } from "hono";
import { Prisma, type PrismaClient } from "@prisma/client";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import { errors } from "../errors.js";
import { log } from "../../log.js";

export const myTrash = new Hono<HumanAuthEnv>();

myTrash.use("*", requireHuman);

// ----------------------------------------------------------------------
// GET /v1/my-trash
// ----------------------------------------------------------------------
myTrash.get("/", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");

  // Pane scope for a human: ones they directly own (ownerHumanId), OR ones
  // owned by an agent they've claimed (agent.ownerHumanId). Either side of
  // the OR can match.
  const paneWhere: Prisma.PaneWhereInput = {
    deletedAt: { not: null },
    OR: [{ ownerHumanId: human.id }, { agent: { ownerHumanId: human.id } }],
  };

  const [panes, templates] = await Promise.all([
    prisma.pane.findMany({
      where: paneWhere,
      orderBy: { deletedAt: "desc" },
      select: {
        id: true,
        title: true,
        deletedAt: true,
        agent: { select: { name: true } },
      },
      take: 200,
    }),
    prisma.template.findMany({
      where: {
        deletedAt: { not: null },
        owner: { ownerHumanId: human.id },
      },
      orderBy: { deletedAt: "desc" },
      select: { id: true, name: true, slug: true, deletedAt: true },
      take: 200,
    }),
  ]);

  return c.json({
    panes: panes.map((p) => ({
      pane_id: p.id,
      title: p.title,
      agent_name: p.agent.name,
      deleted_at: (p.deletedAt as Date).toISOString(),
    })),
    templates: templates.map((t) => ({
      template_id: t.id,
      name: t.name,
      slug: t.slug,
      deleted_at: (t.deletedAt as Date).toISOString(),
    })),
  });
});

// ----------------------------------------------------------------------
// Pane restore / permanent-delete
// ----------------------------------------------------------------------

async function loadTrashedPaneForHuman(
  prisma: PrismaClient,
  paneId: string,
  humanId: string,
): Promise<{
  id: string;
  agentId: string;
  ownerHumanId: string | null;
  deletedAt: Date | null;
}> {
  const pane = await prisma.pane.findUnique({
    where: { id: paneId },
    select: {
      id: true,
      agentId: true,
      ownerHumanId: true,
      deletedAt: true,
      agent: { select: { ownerHumanId: true } },
    },
  });
  if (!pane || pane.deletedAt === null) throw errors.notFound();
  // Owner check: direct human-ownership OR claimed-agent ownership.
  const isOwner =
    pane.ownerHumanId === humanId || pane.agent.ownerHumanId === humanId;
  if (!isOwner) throw errors.notFound();
  return {
    id: pane.id,
    agentId: pane.agentId,
    ownerHumanId: pane.ownerHumanId,
    deletedAt: pane.deletedAt,
  };
}

myTrash.post("/panes/:id/restore", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const pane = await loadTrashedPaneForHuman(prisma, id, human.id);

  await prisma.$transaction(async (tx) => {
    await tx.pane.update({
      where: { id: pane.id },
      data: { deletedAt: null },
    });
    await tx.deletionLog.create({
      data: {
        entityType: "pane",
        entityId: pane.id,
        ownerHumanId: pane.ownerHumanId ?? human.id,
        ownerAgentId: pane.agentId,
        phase: "restored",
        reason: "user_action",
      },
    });
  });

  return c.json({ pane_id: pane.id, deleted_at: null });
});

myTrash.delete("/panes/:id", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const pane = await loadTrashedPaneForHuman(prisma, id, human.id);

  await prisma.$transaction(async (tx) => {
    await tx.deletionLog.create({
      data: {
        entityType: "pane",
        entityId: pane.id,
        ownerHumanId: pane.ownerHumanId ?? human.id,
        ownerAgentId: pane.agentId,
        phase: "hard_deleted",
        reason: "user_immediate",
      },
    });
    await tx.pane.delete({ where: { id: pane.id } });
  });

  log.info("my-trash: pane permanently deleted", {
    paneId: pane.id,
    humanId: human.id,
  });
  return c.body(null, 204);
});

// ----------------------------------------------------------------------
// Template restore / permanent-delete
// ----------------------------------------------------------------------

async function loadTrashedTemplateForHuman(
  prisma: PrismaClient,
  templateId: string,
  humanId: string,
): Promise<{ id: string; ownerId: string }> {
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    select: {
      id: true,
      ownerId: true,
      deletedAt: true,
      owner: { select: { ownerHumanId: true } },
    },
  });
  if (!template || template.deletedAt === null) throw errors.notFound();
  if (template.owner.ownerHumanId !== humanId) throw errors.notFound();
  return { id: template.id, ownerId: template.ownerId };
}

myTrash.post("/templates/:id/restore", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const template = await loadTrashedTemplateForHuman(prisma, id, human.id);

  await prisma.$transaction(async (tx) => {
    await tx.template.update({
      where: { id: template.id },
      data: { deletedAt: null },
    });
    await tx.deletionLog.create({
      data: {
        entityType: "template",
        entityId: template.id,
        ownerHumanId: human.id,
        ownerAgentId: template.ownerId,
        phase: "restored",
        reason: "user_action",
      },
    });
  });

  return c.json({ template_id: template.id, deleted_at: null });
});

myTrash.delete("/templates/:id", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const template = await loadTrashedTemplateForHuman(prisma, id, human.id);

  // Same strict-cascade gate as the agent path: a live pane referencing the
  // template's versions blocks permanent delete.
  const referencingPanes = await prisma.pane.count({
    where: { templateVersion: { templateId: template.id }, deletedAt: null },
  });
  if (referencingPanes > 0) {
    throw errors.conflict(
      `template has ${referencingPanes} live referencing pane(s) — restore or close them first`,
      false,
      `at least one live pane still pins a version of this template; permanently deleting it would orphan the pane. Close or restore-then-delete each referencing pane first.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.deletionLog.create({
      data: {
        entityType: "template",
        entityId: template.id,
        ownerHumanId: human.id,
        ownerAgentId: template.ownerId,
        phase: "hard_deleted",
        reason: "user_immediate",
      },
    });
    await tx.template.delete({ where: { id: template.id } });
  });

  log.info("my-trash: template permanently deleted", {
    templateId: template.id,
    humanId: human.id,
  });
  return c.body(null, 204);
});

export default myTrash;
