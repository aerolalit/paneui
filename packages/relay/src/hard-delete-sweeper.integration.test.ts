// Integration test for the hard-delete sweeper (#304). Covers the tier-
// aware retention resolution, cascade behaviour, audit-log appending, and
// idempotency.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "./test-helpers/db.js";
import { seedPaneRow } from "./test-helpers/seed.js";

let testDb: TestDb;
let prisma: PrismaClient;
let sweepHardDeletable: typeof import("./hard-delete-sweeper.js").sweepHardDeletable;

const DAY_MS = 24 * 60 * 60 * 1000;

const CFG_DEFAULT = {
  HARD_RETENTION_DAYS_FREE: 30,
  HARD_RETENTION_DAYS_PAID: null as number | null,
};

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  const { createPrismaClient } = await import("./db.js");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  ({ sweepHardDeletable } = await import("./hard-delete-sweeper.js"));
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

async function seedAgent(opts: { humanId?: string } = {}): Promise<string> {
  const data: Parameters<typeof prisma.agent.create>[0]["data"] = {
    name: `agent-${randomBytes(4).toString("hex")}`,
    keyHash: randomBytes(32).toString("hex"),
    keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
  };
  if (opts.humanId) data.ownerHumanId = opts.humanId;
  const a = await prisma.agent.create({ data });
  return a.id;
}

async function seedSoftDeletedAgent(opts: {
  humanId?: string;
  deletedDaysAgo: number;
}): Promise<string> {
  const id = await seedAgent(opts.humanId ? { humanId: opts.humanId } : {});
  await prisma.agent.update({
    where: { id },
    data: {
      deletedAt: new Date(Date.now() - opts.deletedDaysAgo * DAY_MS),
    },
  });
  return id;
}

async function seedHuman(
  email: string,
  tier: "free" | "paid" | "system" = "free",
  hardRetentionDays?: number,
): Promise<string> {
  const data: Parameters<typeof prisma.human.create>[0]["data"] = {
    email,
    tier,
  };
  if (hardRetentionDays !== undefined)
    data.hardRetentionDays = hardRetentionDays;
  const h = await prisma.human.create({ data });
  return h.id;
}

async function seedSoftDeletedPane(opts: {
  agentId: string;
  ownerHumanId?: string;
  deletedDaysAgo: number;
}): Promise<string> {
  // seedPaneRow doesn't honor ownerHumanId; set it explicitly after seed
  // alongside the soft-delete timestamp.
  const { paneId } = await seedPaneRow(prisma, {
    agentId: opts.agentId,
    status: "open",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  await prisma.pane.update({
    where: { id: paneId },
    data: {
      deletedAt: new Date(Date.now() - opts.deletedDaysAgo * DAY_MS),
      ownerHumanId: opts.ownerHumanId ?? null,
    },
  });
  return paneId;
}

describe("sweepHardDeletable — tier-aware retention", () => {
  it("free row past 30d is reclaimed", async () => {
    const humanId = await seedHuman("free@example.com", "free");
    const agentId = await seedAgent({ humanId });
    const paneId = await seedSoftDeletedPane({
      agentId,
      ownerHumanId: humanId,
      deletedDaysAgo: 31,
    });

    const r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(r.panes).toBe(1);
    expect(await prisma.pane.findUnique({ where: { id: paneId } })).toBeNull();
  });

  it("free row at 29d is preserved", async () => {
    const humanId = await seedHuman("free2@example.com", "free");
    const agentId = await seedAgent({ humanId });
    const paneId = await seedSoftDeletedPane({
      agentId,
      ownerHumanId: humanId,
      deletedDaysAgo: 29,
    });
    const r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(r.panes).toBe(0);
    expect(
      await prisma.pane.findUnique({ where: { id: paneId } }),
    ).not.toBeNull();
  });

  it("paid row past 30d is preserved when HARD_RETENTION_DAYS_PAID is null (default)", async () => {
    const humanId = await seedHuman("paid@example.com", "paid");
    const agentId = await seedAgent({ humanId });
    const paneId = await seedSoftDeletedPane({
      agentId,
      ownerHumanId: humanId,
      deletedDaysAgo: 365,
    });
    const r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(r.panes).toBe(0);
    expect(
      await prisma.pane.findUnique({ where: { id: paneId } }),
    ).not.toBeNull();
  });

  it("paid row past HARD_RETENTION_DAYS_PAID is reclaimed when the env var is set", async () => {
    const humanId = await seedHuman("paid2@example.com", "paid");
    const agentId = await seedAgent({ humanId });
    const paneId = await seedSoftDeletedPane({
      agentId,
      ownerHumanId: humanId,
      deletedDaysAgo: 400,
    });
    const r = await sweepHardDeletable({
      prisma,
      config: { HARD_RETENTION_DAYS_FREE: 30, HARD_RETENTION_DAYS_PAID: 365 },
    });
    expect(r.panes).toBe(1);
    expect(await prisma.pane.findUnique({ where: { id: paneId } })).toBeNull();
  });

  it("system tier is NEVER reclaimed even past the window", async () => {
    const humanId = await seedHuman("system@example.com", "system");
    const agentId = await seedAgent({ humanId });
    const paneId = await seedSoftDeletedPane({
      agentId,
      ownerHumanId: humanId,
      deletedDaysAgo: 10_000,
    });
    const r = await sweepHardDeletable({
      prisma,
      config: { HARD_RETENTION_DAYS_FREE: 1, HARD_RETENTION_DAYS_PAID: 1 },
    });
    expect(r.panes).toBe(0);
    expect(
      await prisma.pane.findUnique({ where: { id: paneId } }),
    ).not.toBeNull();
  });

  it("per-row hardRetentionDays override beats tier default", async () => {
    const humanId = await seedHuman("override@example.com", "free", 7);
    const agentId = await seedAgent({ humanId });
    const paneId = await seedSoftDeletedPane({
      agentId,
      ownerHumanId: humanId,
      deletedDaysAgo: 10,
    });
    const r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(r.panes).toBe(1);
    expect(await prisma.pane.findUnique({ where: { id: paneId } })).toBeNull();
  });

  it("pane with no owner human uses HARD_RETENTION_DAYS_FREE", async () => {
    const agentId = await seedAgent();
    const paneId = await seedSoftDeletedPane({
      agentId,
      deletedDaysAgo: 31,
    });
    const r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(r.panes).toBe(1);
    expect(await prisma.pane.findUnique({ where: { id: paneId } })).toBeNull();
  });
});

describe("sweepHardDeletable — cascade + audit", () => {
  it("pane hard-delete cascades to events + record_collections + participants", async () => {
    const humanId = await seedHuman("c@example.com", "free");
    const agentId = await seedAgent({ humanId });
    const paneId = await seedSoftDeletedPane({
      agentId,
      ownerHumanId: humanId,
      deletedDaysAgo: 31,
    });
    await prisma.event.create({
      data: {
        paneId,
        authorKind: "agent",
        authorId: agentId,
        type: "x.y",
        data: {},
      },
    });
    await prisma.recordCollection.create({
      data: { paneId, name: "comments", seq: 1 },
    });
    await prisma.participant.create({
      data: {
        paneId,
        kind: "human",
        identityId: humanId,
        humanId,
        tokenHash: randomBytes(32).toString("hex"),
        tokenPrefix: "tok_h_pre",
      },
    });

    await sweepHardDeletable({ prisma, config: CFG_DEFAULT });

    expect(await prisma.event.count({ where: { paneId } })).toBe(0);
    expect(await prisma.recordCollection.count({ where: { paneId } })).toBe(0);
    expect(await prisma.participant.count({ where: { paneId } })).toBe(0);
  });

  // Note: there is no "anonymous template orphan reclamation" anymore — every
  // template is named (name NOT NULL), so all templates are reusable
  // identities that survive their panes (asserted below).

  it("named template survives even after its panes are reclaimed", async () => {
    const humanId = await seedHuman("named@example.com", "free");
    const agentId = await seedAgent({ humanId });
    const tmpl = await prisma.template.create({
      data: { ownerId: agentId, name: "PR Review", slug: "pr-review" },
    });
    const tv = await prisma.templateVersion.create({
      data: {
        templateId: tmpl.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p/>",
      },
    });
    const { paneId } = await seedPaneRow(prisma, {
      agentId,
      ownerHumanId: humanId,
      templateVersionId: tv.id,
      status: "open",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await prisma.pane.update({
      where: { id: paneId },
      data: { deletedAt: new Date(Date.now() - 31 * DAY_MS) },
    });

    await sweepHardDeletable({ prisma, config: CFG_DEFAULT });

    expect(
      await prisma.template.findUnique({ where: { id: tmpl.id } }),
    ).not.toBeNull();
  });

  it("appends one deletion_log row per hard-delete with phase + reason + owner anchors", async () => {
    const humanId = await seedHuman("aud@example.com", "free");
    const agentId = await seedAgent({ humanId });
    const paneId = await seedSoftDeletedPane({
      agentId,
      ownerHumanId: humanId,
      deletedDaysAgo: 31,
    });

    await sweepHardDeletable({ prisma, config: CFG_DEFAULT });

    const logs = await prisma.deletionLog.findMany({
      where: { entityType: "pane", entityId: paneId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.phase).toBe("hard_deleted");
    expect(logs[0]!.reason).toBe("retention_window_elapsed");
    expect(logs[0]!.ownerHumanId).toBe(humanId);
    expect(logs[0]!.ownerAgentId).toBe(agentId);
  });

  it("is idempotent — second pass over already-reclaimed rows is no-op", async () => {
    const humanId = await seedHuman("idem@example.com", "free");
    const agentId = await seedAgent({ humanId });
    await seedSoftDeletedPane({
      agentId,
      ownerHumanId: humanId,
      deletedDaysAgo: 31,
    });

    const first = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(first.panes).toBe(1);
    const second = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(second.panes).toBe(0);
  });

  it("no-op when nothing is past retention", async () => {
    const humanId = await seedHuman("none@example.com", "free");
    const agentId = await seedAgent({ humanId });
    await seedSoftDeletedPane({
      agentId,
      ownerHumanId: humanId,
      deletedDaysAgo: 5,
    });
    const r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(r).toEqual({
      panes: 0,
      attachments: 0,
      templates: 0,
      agents: 0,
      humans: 0,
    });
  });
});

describe("sweepAgents — Restrict-child guard (#506)", () => {
  // Before this guard, a soft-deleted past-retention agent that still owned any
  // Pane/Template/Attachment row made the flat `agent.deleteMany` throw a P2003
  // FK-restrict error and abort the whole sweep pass. The guard defers such an
  // agent (excludes it from the eligible set) instead of throwing.

  it("does NOT throw or delete an agent that still owns an active pane", async () => {
    const agentId = await seedSoftDeletedAgent({ deletedDaysAgo: 60 });
    // Active (non-soft-deleted) pane keeps the Restrict FK alive across the pass.
    await seedPaneRow(prisma, {
      agentId,
      status: "open",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    let r: Awaited<ReturnType<typeof sweepHardDeletable>>;
    await expect(
      (async () => {
        r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
      })(),
    ).resolves.toBeUndefined();

    expect(r!.agents).toBe(0);
    expect(
      await prisma.agent.findUnique({ where: { id: agentId } }),
    ).not.toBeNull();
    // No audit row should be written for a deferred agent.
    expect(
      await prisma.deletionLog.count({
        where: { entityType: "agent", entityId: agentId },
      }),
    ).toBe(0);
  });

  it("does NOT throw or delete an agent that still owns a template", async () => {
    const agentId = await seedSoftDeletedAgent({ deletedDaysAgo: 60 });
    await prisma.template.create({
      data: { ownerId: agentId, name: "Owned Template", slug: "owned-tmpl" },
    });

    let r: Awaited<ReturnType<typeof sweepHardDeletable>>;
    await expect(
      (async () => {
        r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
      })(),
    ).resolves.toBeUndefined();

    expect(r!.agents).toBe(0);
    expect(
      await prisma.agent.findUnique({ where: { id: agentId } }),
    ).not.toBeNull();
  });

  it("does NOT throw or delete an agent that still owns an attachment", async () => {
    const agentId = await seedSoftDeletedAgent({ deletedDaysAgo: 60 });
    await prisma.attachment.create({
      data: {
        ownerId: agentId,
        scope: "agent",
        mime: "image/png",
        size: 100,
        sha256: "f".repeat(64),
        storageKey: `att_${randomBytes(8).toString("hex")}`,
        status: "ready",
      },
    });

    let r: Awaited<ReturnType<typeof sweepHardDeletable>>;
    await expect(
      (async () => {
        r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
      })(),
    ).resolves.toBeUndefined();

    expect(r!.agents).toBe(0);
    expect(
      await prisma.agent.findUnique({ where: { id: agentId } }),
    ).not.toBeNull();
  });

  it("defers an agent that owns an active pane, then reclaims it once the pane (and its template) are gone", async () => {
    const agentId = await seedSoftDeletedAgent({ deletedDaysAgo: 60 });
    // Active pane keeps the Restrict FK alive; seedPaneRow also creates a
    // named Template owned by this agent (another Restrict child).
    const { paneId, templateVersionId } = await seedPaneRow(prisma, {
      agentId,
      status: "open",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const first = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(first.agents).toBe(0);
    expect(
      await prisma.agent.findUnique({ where: { id: agentId } }),
    ).not.toBeNull();

    // Remove BOTH Restrict children (pane + the template it pinned), then the
    // agent is FK-safe and reclaimed on the next pass.
    const tv = await prisma.templateVersion.findUniqueOrThrow({
      where: { id: templateVersionId },
      select: { templateId: true },
    });
    await prisma.pane.delete({ where: { id: paneId } });
    await prisma.template.delete({ where: { id: tv.templateId } });

    const second = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(second.agents).toBe(1);
    expect(
      await prisma.agent.findUnique({ where: { id: agentId } }),
    ).toBeNull();
    const logs = await prisma.deletionLog.findMany({
      where: { entityType: "agent", entityId: agentId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.phase).toBe("hard_deleted");
  });

  it("keeps deferring an agent whose only remaining child is a (still-live) template", async () => {
    // A past-retention agent that owns a named template the user never deleted
    // stays deferred indefinitely — templates are reusable identities that
    // survive their panes and are not auto-swept. The agent is NOT a black
    // hole: the deferral is observable via the logged count, and the agent is
    // reclaimed once account-deletion (#312) purges the template.
    const agentId = await seedSoftDeletedAgent({ deletedDaysAgo: 60 });
    const { paneId } = await seedPaneRow(prisma, {
      agentId,
      status: "open",
      expiresAt: new Date(Date.now() - 1), // already expired → soft-deletable
    });
    await prisma.pane.update({
      where: { id: paneId },
      data: { deletedAt: new Date(Date.now() - 31 * DAY_MS) },
    });

    // Pane is past retention → swept this pass. Template survives → agent stays.
    const r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(r.panes).toBe(1);
    expect(r.agents).toBe(0);
    expect(
      await prisma.agent.findUnique({ where: { id: agentId } }),
    ).not.toBeNull();
  });

  it("regression: a standalone past-retention agent owning nothing is hard-deleted with a deletion_log row", async () => {
    const agentId = await seedSoftDeletedAgent({ deletedDaysAgo: 60 });

    const r = await sweepHardDeletable({ prisma, config: CFG_DEFAULT });
    expect(r.agents).toBe(1);
    expect(
      await prisma.agent.findUnique({ where: { id: agentId } }),
    ).toBeNull();
    const logs = await prisma.deletionLog.findMany({
      where: { entityType: "agent", entityId: agentId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.phase).toBe("hard_deleted");
    expect(logs[0]!.reason).toBe("retention_window_elapsed");
  });
});
