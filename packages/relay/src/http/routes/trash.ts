// #306 — /v1/trash: the trash API for soft-deleted entities.
//
//   GET    /v1/trash                            list everything in trash
//   POST   /v1/trash/panes/:id/restore          clear deletedAt (un-trash)
//   POST   /v1/trash/templates/:id/restore      clear deletedAt (un-trash)
//   DELETE /v1/trash/panes/:id                  permanent hard-delete now
//   DELETE /v1/trash/templates/:id              permanent hard-delete now
//
// Per-entity rather than a generic /v1/trash/:type/:id because the route
// table is read more than it is written, and the explicit entity in the
// path makes "what does this endpoint touch" obvious at a glance. The cost
// is two near-identical handlers per verb; the payoff is no `type === "..."`
// switch inside the handlers.
//
// All routes are agent-scoped via #283's `agentScope` helper — a claimed
// agent can restore/permanent-delete the trash of any sibling agent owned by
// the same human. Strictly unrelated agents resolve to 404 (existence-oracle
// parity with the live-resource routes).
//
// Every state change (restore, permanent-delete) appends to DeletionLog so
// the audit trail is complete; the live routes already log the soft-delete
// side via the TTL sweeper (#303) and the hard-delete sweeper (#304).

import { Hono } from "hono";
import { Prisma, type PrismaClient } from "@prisma/client";
import { requireAgent, type AuthEnv } from "../auth.js";
import { agentScope } from "../agent-scope.js";
import { errors } from "../errors.js";
import { log } from "../../log.js";

const trash = new Hono<AuthEnv>();

trash.use("*", requireAgent);

// ---------------------------------------------------------------------------
// GET /v1/trash — list everything in this human's trash.
// ---------------------------------------------------------------------------
// Categorised by entity type. Lean projection (id + name + deleted_at), no
// content payloads — the trash UI shows a "remove" / "restore" choice, not
// the row's contents.
//
// Scope: rows owned by the agent OR by any same-human sibling agent (#283).
// An unclaimed agent (ownerHumanId === null) only sees its own trash.
trash.get("/", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const scope = await agentScope(prisma, agent);
  const scopeArr = [...scope];

  // Panes: agent-owned (always) AND, for claimed agents, ones the same human
  // owns directly (a pane whose ownerHumanId is the agent's owner).
  const ownerHumanId = agent.ownerHumanId;
  const paneWhere: Prisma.PaneWhereInput =
    ownerHumanId !== null
      ? {
          deletedAt: { not: null },
          OR: [{ agentId: { in: scopeArr } }, { ownerHumanId }],
        }
      : {
          deletedAt: { not: null },
          agentId: { in: scopeArr },
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
        ownerId: { in: scopeArr },
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
      // deletedAt is non-null by virtue of the where clause; the `!` is
      // narrative — Prisma's findMany return type doesn't narrow it for us.
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

// ---------------------------------------------------------------------------
// Pane restore / permanent-delete
// ---------------------------------------------------------------------------

// Owner-check + soft-deleted assertion shared between restore + permanent.
// Returns the matched pane scalar fields needed by both handlers; throws
// `notFound` for missing / out-of-scope / not-in-trash.
async function loadTrashedPane(
  prisma: PrismaClient,
  paneId: string,
  agent: { id: string; ownerHumanId: string | null },
): Promise<{
  id: string;
  agentId: string;
  ownerHumanId: string | null;
  deletedAt: Date | null;
}> {
  const scope = await agentScope(prisma, agent);
  const pane = await prisma.pane.findUnique({
    where: { id: paneId },
    select: {
      id: true,
      agentId: true,
      ownerHumanId: true,
      deletedAt: true,
    },
  });
  // Existence-oracle parity with the live routes: a missing row, an
  // out-of-scope row, and a not-soft-deleted row all collapse to the same
  // 404. The trash routes deliberately do NOT distinguish "not in trash"
  // from "doesn't exist" — knowing a pane id is live but in someone else's
  // scope is an information leak.
  if (!pane || pane.deletedAt === null) throw errors.notFound();
  if (!scope.has(pane.agentId)) throw errors.notFound();
  return pane;
}

trash.post("/panes/:id/restore", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const id = c.req.param("id");

  const pane = await loadTrashedPane(prisma, id, agent);

  // Restore in a transaction with the DeletionLog append so the audit row
  // can never be missing while the live row is back.
  await prisma.$transaction(async (tx) => {
    await tx.pane.update({
      where: { id: pane.id },
      data: { deletedAt: null },
    });
    await tx.deletionLog.create({
      data: {
        entityType: "pane",
        entityId: pane.id,
        ownerHumanId: pane.ownerHumanId,
        ownerAgentId: pane.agentId,
        phase: "restored",
        reason: "user_action",
      },
    });
  });

  return c.json({ pane_id: pane.id, deleted_at: null });
});

trash.delete("/panes/:id", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const id = c.req.param("id");

  const pane = await loadTrashedPane(prisma, id, agent);

  // Hard-delete + DeletionLog (phase='hard_deleted'). The DeletionLog must
  // be written FIRST — once the row is gone, we lose the FK context. The
  // cascade on Pane → Event / Participant / RecordCollection takes care of
  // dependent rows. Pane-scope attachments are handled by their own
  // sweeper (#304) and the AttachmentStore — we do NOT attempt to purge
  // attachment blobs here. The caller asked for an immediate trash purge;
  // attachment garbage collection is a separate concern that runs hourly.
  await prisma.$transaction(async (tx) => {
    await tx.deletionLog.create({
      data: {
        entityType: "pane",
        entityId: pane.id,
        ownerHumanId: pane.ownerHumanId,
        ownerAgentId: pane.agentId,
        phase: "hard_deleted",
        reason: "user_immediate",
      },
    });
    await tx.pane.delete({ where: { id: pane.id } });
  });

  log.info("trash: pane permanently deleted", {
    paneId: pane.id,
    agentId: agent.id,
  });
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Template restore / permanent-delete
// ---------------------------------------------------------------------------

async function loadTrashedTemplate(
  prisma: PrismaClient,
  templateId: string,
  agent: { id: string; ownerHumanId: string | null },
): Promise<{
  id: string;
  ownerId: string;
  deletedAt: Date | null;
}> {
  const scope = await agentScope(prisma, agent);
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    select: { id: true, ownerId: true, deletedAt: true },
  });
  if (!template || template.deletedAt === null) throw errors.notFound();
  if (!scope.has(template.ownerId)) throw errors.notFound();
  return template;
}

trash.post("/templates/:id/restore", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const id = c.req.param("id");

  const template = await loadTrashedTemplate(prisma, id, agent);

  await prisma.$transaction(async (tx) => {
    await tx.template.update({
      where: { id: template.id },
      data: { deletedAt: null },
    });
    await tx.deletionLog.create({
      data: {
        entityType: "template",
        entityId: template.id,
        ownerHumanId: agent.ownerHumanId,
        ownerAgentId: template.ownerId,
        phase: "restored",
        reason: "user_action",
      },
    });
  });

  return c.json({ template_id: template.id, deleted_at: null });
});

trash.delete("/templates/:id", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const id = c.req.param("id");

  const template = await loadTrashedTemplate(prisma, id, agent);

  // Templates have the same strict-cascade constraint as the live DELETE
  // path: any pane referencing one of this template's versions blocks the
  // permanent delete. Live panes shouldn't reference a soft-deleted
  // template (they'd be unreachable), but the check is cheap and prevents
  // a corrupt-cascade if something else slipped the invariant.
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
        ownerHumanId: agent.ownerHumanId,
        ownerAgentId: template.ownerId,
        phase: "hard_deleted",
        reason: "user_immediate",
      },
    });
    await tx.template.delete({ where: { id: template.id } });
  });

  log.info("trash: template permanently deleted", {
    templateId: template.id,
    agentId: agent.id,
  });
  return c.body(null, 204);
});

export default trash;
