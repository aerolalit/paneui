// #306 — /v1/trash routes. End-to-end tests covering:
//   - GET /v1/trash lists soft-deleted panes + templates owned by the caller
//   - Scope: an agent only sees its own trash, plus same-human siblings (#283)
//   - POST /v1/trash/panes/:id/restore clears deletedAt + appends DeletionLog
//   - POST /v1/trash/templates/:id/restore likewise
//   - DELETE /v1/trash/panes/:id permanently hard-deletes + audit row
//   - DELETE /v1/trash/templates/:id permanently hard-deletes
//   - Permanent template-delete is refused (409) when a live pane references
//     one of its versions

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { hashKey, keyPrefix } from "../../keys.js";
import { buildApp } from "../app.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(
    loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
    }),
    prisma,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

const eventSchema = {
  events: {
    ping: { payload: { type: "object" }, emittedBy: ["page", "agent"] },
  },
};

function bearer(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

async function seedAgent(
  ownerHumanId: string | null = null,
): Promise<{ id: string; apiKey: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const a = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
      ownerHumanId,
    },
  });
  return { id: a.id, apiKey };
}

async function createPane(
  apiKey: string,
  title = "Test",
): Promise<{ pane_id: string }> {
  const res = await app.fetch(
    new Request("http://t/v1/panes", {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify({
        template: {
          name: "Test template",
          type: "html-inline",
          source: "<html></html>",
          event_schema: eventSchema,
        },
        title,
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { pane_id: string };
}

async function trashPane(paneId: string): Promise<void> {
  await prisma.pane.update({
    where: { id: paneId },
    data: { deletedAt: new Date() },
  });
}

async function createNamedTemplate(
  apiKey: string,
  slug?: string,
): Promise<{ template_id: string }> {
  const res = await app.fetch(
    new Request("http://t/v1/templates", {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify({
        name: "T",
        slug: slug ?? `t-${randomBytes(4).toString("hex")}`,
        source: "<html></html>",
        type: "html-inline",
        event_schema: eventSchema,
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { template_id: string };
}

async function trashTemplate(templateId: string): Promise<void> {
  await prisma.template.update({
    where: { id: templateId },
    data: { deletedAt: new Date() },
  });
}

describe("GET /v1/trash", () => {
  it("returns the caller's soft-deleted panes and templates", async () => {
    const a = await seedAgent();
    const live = await createPane(a.apiKey, "live");
    const trashed1 = await createPane(a.apiKey, "t1");
    const trashed2 = await createPane(a.apiKey, "t2");
    await trashPane(trashed1.pane_id);
    await trashPane(trashed2.pane_id);

    const tpl = await createNamedTemplate(a.apiKey, "trash-tpl");
    await trashTemplate(tpl.template_id);

    const res = await app.fetch(
      new Request("http://t/v1/trash", { headers: bearer(a.apiKey) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      panes: { pane_id: string; deleted_at: string }[];
      templates: { template_id: string }[];
    };
    const paneIds = body.panes.map((p) => p.pane_id);
    expect(paneIds).toContain(trashed1.pane_id);
    expect(paneIds).toContain(trashed2.pane_id);
    expect(paneIds).not.toContain(live.pane_id);
    expect(body.templates.map((t) => t.template_id)).toContain(tpl.template_id);
    // Every returned pane has a deleted_at timestamp.
    expect(body.panes.every((p) => typeof p.deleted_at === "string")).toBe(
      true,
    );
  });

  it("does NOT leak other agents' trash (cross-agent isolation)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const ap = await createPane(a.apiKey, "a");
    const bp = await createPane(b.apiKey, "b");
    await trashPane(ap.pane_id);
    await trashPane(bp.pane_id);

    const resA = await app.fetch(
      new Request("http://t/v1/trash", { headers: bearer(a.apiKey) }),
    );
    const bodyA = (await resA.json()) as { panes: { pane_id: string }[] };
    expect(bodyA.panes.map((p) => p.pane_id)).toEqual([ap.pane_id]);
  });

  it("returns empty arrays when nothing is in trash", async () => {
    const a = await seedAgent();
    await createPane(a.apiKey);

    const res = await app.fetch(
      new Request("http://t/v1/trash", { headers: bearer(a.apiKey) }),
    );
    const body = (await res.json()) as {
      panes: unknown[];
      templates: unknown[];
    };
    expect(body.panes).toHaveLength(0);
    expect(body.templates).toHaveLength(0);
  });
});

describe("POST /v1/trash/panes/:id/restore", () => {
  it("clears deletedAt and writes a DeletionLog audit row", async () => {
    const a = await seedAgent();
    const p = await createPane(a.apiKey);
    await trashPane(p.pane_id);

    const res = await app.fetch(
      new Request(`http://t/v1/trash/panes/${p.pane_id}/restore`, {
        method: "POST",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pane_id: string; deleted_at: null };
    expect(body.pane_id).toBe(p.pane_id);
    expect(body.deleted_at).toBeNull();

    const row = await prisma.pane.findUnique({ where: { id: p.pane_id } });
    expect(row?.deletedAt).toBeNull();

    const auditRow = await prisma.deletionLog.findFirst({
      where: { entityType: "pane", entityId: p.pane_id, phase: "restored" },
    });
    expect(auditRow).toBeTruthy();
    expect(auditRow?.reason).toBe("user_action");
  });

  it("404s on a live (not soft-deleted) pane", async () => {
    const a = await seedAgent();
    const p = await createPane(a.apiKey);
    // No trashPane — pane is still live.
    const res = await app.fetch(
      new Request(`http://t/v1/trash/panes/${p.pane_id}/restore`, {
        method: "POST",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404s when another agent owns the trashed pane", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const p = await createPane(a.apiKey);
    await trashPane(p.pane_id);

    const res = await app.fetch(
      new Request(`http://t/v1/trash/panes/${p.pane_id}/restore`, {
        method: "POST",
        headers: bearer(b.apiKey),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404s on an unknown id", async () => {
    const a = await seedAgent();
    const res = await app.fetch(
      new Request(`http://t/v1/trash/panes/sur_doesnotexist/restore`, {
        method: "POST",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/trash/panes/:id", () => {
  it("permanently deletes a trashed pane and writes a hard_deleted audit row", async () => {
    const a = await seedAgent();
    const p = await createPane(a.apiKey);
    await trashPane(p.pane_id);

    const res = await app.fetch(
      new Request(`http://t/v1/trash/panes/${p.pane_id}`, {
        method: "DELETE",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(204);

    const row = await prisma.pane.findUnique({ where: { id: p.pane_id } });
    expect(row).toBeNull();

    const auditRow = await prisma.deletionLog.findFirst({
      where: {
        entityType: "pane",
        entityId: p.pane_id,
        phase: "hard_deleted",
      },
    });
    expect(auditRow).toBeTruthy();
    expect(auditRow?.reason).toBe("user_immediate");
  });

  it("404s on a live (not trashed) pane", async () => {
    const a = await seedAgent();
    const p = await createPane(a.apiKey);

    const res = await app.fetch(
      new Request(`http://t/v1/trash/panes/${p.pane_id}`, {
        method: "DELETE",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(404);
    // Pane row still alive.
    const row = await prisma.pane.findUnique({ where: { id: p.pane_id } });
    expect(row).not.toBeNull();
  });
});

describe("POST /v1/trash/templates/:id/restore", () => {
  it("restores a trashed template and writes a DeletionLog", async () => {
    const a = await seedAgent();
    const t = await createNamedTemplate(a.apiKey);
    await trashTemplate(t.template_id);

    const res = await app.fetch(
      new Request(`http://t/v1/trash/templates/${t.template_id}/restore`, {
        method: "POST",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(200);

    const row = await prisma.template.findUnique({
      where: { id: t.template_id },
    });
    expect(row?.deletedAt).toBeNull();

    const auditRow = await prisma.deletionLog.findFirst({
      where: {
        entityType: "template",
        entityId: t.template_id,
        phase: "restored",
      },
    });
    expect(auditRow).toBeTruthy();
  });

  it("404s on a live template (deletedAt is null)", async () => {
    const a = await seedAgent();
    const t = await createNamedTemplate(a.apiKey);

    const res = await app.fetch(
      new Request(`http://t/v1/trash/templates/${t.template_id}/restore`, {
        method: "POST",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/trash/templates/:id", () => {
  it("permanently deletes a trashed template", async () => {
    const a = await seedAgent();
    const t = await createNamedTemplate(a.apiKey);
    await trashTemplate(t.template_id);

    const res = await app.fetch(
      new Request(`http://t/v1/trash/templates/${t.template_id}`, {
        method: "DELETE",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(204);
    const row = await prisma.template.findUnique({
      where: { id: t.template_id },
    });
    expect(row).toBeNull();
    const auditRow = await prisma.deletionLog.findFirst({
      where: {
        entityType: "template",
        entityId: t.template_id,
        phase: "hard_deleted",
      },
    });
    expect(auditRow).toBeTruthy();
  });

  it("refuses with 409 when a live pane references the trashed template", async () => {
    // Author template → create pane → trash template (pane still references it,
    // since the route doesn't soft-delete panes on template delete).
    const a = await seedAgent();
    const t = await createNamedTemplate(a.apiKey, "ref-tpl");
    await app.fetch(
      new Request("http://t/v1/panes", {
        method: "POST",
        headers: bearer(a.apiKey),
        body: JSON.stringify({
          template: { id: t.template_id },
          title: "uses-tpl",
        }),
      }),
    );
    await trashTemplate(t.template_id);

    const res = await app.fetch(
      new Request(`http://t/v1/trash/templates/${t.template_id}`, {
        method: "DELETE",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(409);
    // Template still in trash, not hard-deleted.
    const row = await prisma.template.findUnique({
      where: { id: t.template_id },
    });
    expect(row).not.toBeNull();
  });
});

describe("same-human scope (#283)", () => {
  it("a claimed sibling agent can restore another agent's trashed pane", async () => {
    const human = await prisma.human.create({
      data: { email: `h-${randomBytes(4).toString("hex")}@example.com` },
    });
    const a = await seedAgent(human.id);
    const b = await seedAgent(human.id);
    const p = await createPane(a.apiKey, "sib");
    await trashPane(p.pane_id);

    // Both should see the trashed pane.
    const resA = await app.fetch(
      new Request("http://t/v1/trash", { headers: bearer(a.apiKey) }),
    );
    const bodyA = (await resA.json()) as { panes: { pane_id: string }[] };
    expect(bodyA.panes.map((x) => x.pane_id)).toContain(p.pane_id);
    const resB = await app.fetch(
      new Request("http://t/v1/trash", { headers: bearer(b.apiKey) }),
    );
    const bodyB = (await resB.json()) as { panes: { pane_id: string }[] };
    expect(bodyB.panes.map((x) => x.pane_id)).toContain(p.pane_id);

    // Sibling restores.
    const restoreRes = await app.fetch(
      new Request(`http://t/v1/trash/panes/${p.pane_id}/restore`, {
        method: "POST",
        headers: bearer(b.apiKey),
      }),
    );
    expect(restoreRes.status).toBe(200);
  });
});
