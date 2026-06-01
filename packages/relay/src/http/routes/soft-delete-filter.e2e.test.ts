// #305 — routes filter for soft-deleted entities. Tests that:
//
//   - GET /v1/panes hides soft-deleted rows by default and exposes them
//     when ?include_deleted=true.
//   - GET /v1/panes/:id always returns the row, with deleted_at populated
//     when soft-deleted (so the trash UI can render details).
//   - Mutations on a soft-deleted pane (upgrade, ws-ticket, mint
//     participant) return 410 soft_deleted with a restore-from-trash hint.
//   - DELETE /v1/panes/:id is idempotent against a soft-deleted row
//     (still 204) — the caller's "close this" intent is already satisfied.
//   - The same patterns apply to templates: list hides, GET shows with
//     deleted_at, mutations 410.
//
// Tests bypass the (yet-to-land) trash API by setting deletedAt directly via
// Prisma — #306 will provide the public soft-delete entry point.

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

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const a = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
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

async function softDeletePane(paneId: string): Promise<void> {
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

async function softDeleteTemplate(templateId: string): Promise<void> {
  await prisma.template.update({
    where: { id: templateId },
    data: { deletedAt: new Date() },
  });
}

describe("panes — soft-delete filter (#305)", () => {
  it("hides soft-deleted panes from GET /v1/panes by default", async () => {
    const a = await seedAgent();
    const live = await createPane(a.apiKey, "live");
    const trashed = await createPane(a.apiKey, "trashed");
    await softDeletePane(trashed.pane_id);

    const res = await app.fetch(
      new Request("http://t/v1/panes", { headers: bearer(a.apiKey) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { pane_id: string; deleted_at: string | null }[];
    };
    const ids = body.items.map((i) => i.pane_id);
    expect(ids).toContain(live.pane_id);
    expect(ids).not.toContain(trashed.pane_id);
    expect(
      body.items.find((i) => i.pane_id === live.pane_id)?.deleted_at,
    ).toBeNull();
  });

  it("includes soft-deleted panes when ?include_deleted=true", async () => {
    const a = await seedAgent();
    const live = await createPane(a.apiKey, "live");
    const trashed = await createPane(a.apiKey, "trashed");
    await softDeletePane(trashed.pane_id);

    const res = await app.fetch(
      new Request("http://t/v1/panes?include_deleted=true", {
        headers: bearer(a.apiKey),
      }),
    );
    const body = (await res.json()) as {
      items: { pane_id: string; deleted_at: string | null }[];
    };
    const trashedItem = body.items.find((i) => i.pane_id === trashed.pane_id);
    expect(trashedItem).toBeDefined();
    expect(trashedItem?.deleted_at).not.toBeNull();
    expect(body.items.some((i) => i.pane_id === live.pane_id)).toBe(true);
  });

  it("GET /v1/panes/:id returns soft-deleted with deleted_at populated", async () => {
    const a = await seedAgent();
    const s = await createPane(a.apiKey);
    await softDeletePane(s.pane_id);

    const res = await app.fetch(
      new Request(`http://t/v1/panes/${s.pane_id}`, {
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pane_id: string;
      deleted_at: string | null;
    };
    expect(body.pane_id).toBe(s.pane_id);
    expect(body.deleted_at).not.toBeNull();
  });

  it("POST /v1/panes/:id/upgrade returns 410 soft_deleted on a trashed pane", async () => {
    const a = await seedAgent();
    const s = await createPane(a.apiKey);
    await softDeletePane(s.pane_id);

    const res = await app.fetch(
      new Request(`http://t/v1/panes/${s.pane_id}/upgrade`, {
        method: "POST",
        headers: bearer(a.apiKey),
        body: "{}",
      }),
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as {
      error: { code: string; hint?: string };
    };
    expect(body.error.code).toBe("soft_deleted");
    expect(body.error.hint).toMatch(/restore/);
  });

  it("POST /v1/panes/:id/participants returns 410 soft_deleted", async () => {
    const a = await seedAgent();
    const s = await createPane(a.apiKey);
    await softDeletePane(s.pane_id);

    const res = await app.fetch(
      new Request(`http://t/v1/panes/${s.pane_id}/participants`, {
        method: "POST",
        headers: bearer(a.apiKey),
        body: JSON.stringify({ kind: "human" }),
      }),
    );
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "soft_deleted",
    );
  });

  it("POST /v1/panes/:id/ws-ticket returns 410 soft_deleted", async () => {
    const a = await seedAgent();
    const s = await createPane(a.apiKey);
    await softDeletePane(s.pane_id);

    const res = await app.fetch(
      new Request(`http://t/v1/panes/${s.pane_id}/ws-ticket`, {
        method: "POST",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "soft_deleted",
    );
  });

  it("DELETE /v1/panes/:id is idempotent (204) when already soft-deleted", async () => {
    const a = await seedAgent();
    const s = await createPane(a.apiKey);
    await softDeletePane(s.pane_id);

    const res = await app.fetch(
      new Request(`http://t/v1/panes/${s.pane_id}`, {
        method: "DELETE",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(204);
  });

  it("contextKey dedup pre-check skips soft-deleted rows (findFirst filter)", async () => {
    // Narrow assertion: the explicit pre-check `findFirst` no longer
    // matches a soft-deleted row, so creating a new pane with the
    // same context_key after the prior one is trashed does NOT hand the
    // caller back the trashed row.
    const human = await prisma.human.create({
      data: { email: `h-${randomBytes(4).toString("hex")}@example.com` },
    });
    const apiKey = "pane_" + randomBytes(16).toString("hex");
    await prisma.agent.create({
      data: {
        name: `agent-${randomBytes(4).toString("hex")}`,
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
        ownerHumanId: human.id,
      },
    });
    const tpl = await createNamedTemplate(apiKey, "dedup-tpl");

    const create = async () => {
      return await app.fetch(
        new Request("http://t/v1/panes", {
          method: "POST",
          headers: bearer(apiKey),
          body: JSON.stringify({
            template: { id: tpl.template_id },
            title: "ctx",
            context_key: "shared-key",
          }),
        }),
      );
    };

    const firstRes = await create();
    expect([200, 201]).toContain(firstRes.status);
    const first = (await firstRes.json()) as { pane_id: string };
    const secondRes = await create();
    expect(secondRes.status).toBe(200);
    expect(((await secondRes.json()) as { pane_id: string }).pane_id).toBe(
      first.pane_id,
    );

    await softDeletePane(first.pane_id);
    const thirdRes = await create();
    if (thirdRes.status === 200 || thirdRes.status === 201) {
      const third = (await thirdRes.json()) as { pane_id: string };
      expect(third.pane_id).not.toBe(first.pane_id);
    } else {
      // 409 from the residual unique-constraint hit is also acceptable for
      // #305 — the trashed row is not handed back as a successful dedup.
      expect(thirdRes.status).toBe(409);
    }
  });
});

describe("templates — soft-delete filter (#305)", () => {
  it("hides soft-deleted templates from GET /v1/templates", async () => {
    const a = await seedAgent();
    const live = await createNamedTemplate(a.apiKey, "live-tpl");
    const trashed = await createNamedTemplate(a.apiKey, "trashed-tpl");
    await softDeleteTemplate(trashed.template_id);

    const res = await app.fetch(
      new Request("http://t/v1/templates", { headers: bearer(a.apiKey) }),
    );
    const body = (await res.json()) as { templates: { id: string }[] };
    const ids = body.templates.map((t) => t.id);
    expect(ids).toContain(live.template_id);
    expect(ids).not.toContain(trashed.template_id);
  });

  it("includes soft-deleted templates with ?include_deleted=true", async () => {
    const a = await seedAgent();
    const trashed = await createNamedTemplate(a.apiKey);
    await softDeleteTemplate(trashed.template_id);

    const res = await app.fetch(
      new Request("http://t/v1/templates?include_deleted=true", {
        headers: bearer(a.apiKey),
      }),
    );
    const body = (await res.json()) as { templates: { id: string }[] };
    expect(body.templates.some((t) => t.id === trashed.template_id)).toBe(true);
  });

  it("GET /v1/templates/:id exposes deleted_at on trashed templates", async () => {
    const a = await seedAgent();
    const t = await createNamedTemplate(a.apiKey);
    await softDeleteTemplate(t.template_id);

    const res = await app.fetch(
      new Request(`http://t/v1/templates/${t.template_id}`, {
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted_at: string | null };
    expect(body.deleted_at).not.toBeNull();
  });

  it("POST /v1/templates/:id/versions returns 410 soft_deleted on trashed template", async () => {
    const a = await seedAgent();
    const t = await createNamedTemplate(a.apiKey);
    await softDeleteTemplate(t.template_id);

    const res = await app.fetch(
      new Request(`http://t/v1/templates/${t.template_id}/versions`, {
        method: "POST",
        headers: bearer(a.apiKey),
        body: JSON.stringify({
          source: "<html>v2</html>",
          type: "html-inline",
          event_schema: eventSchema,
        }),
      }),
    );
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "soft_deleted",
    );
  });

  it("PATCH /v1/templates/:id returns 410 soft_deleted on trashed template", async () => {
    const a = await seedAgent();
    const t = await createNamedTemplate(a.apiKey);
    await softDeleteTemplate(t.template_id);

    const res = await app.fetch(
      new Request(`http://t/v1/templates/${t.template_id}`, {
        method: "PATCH",
        headers: bearer(a.apiKey),
        body: JSON.stringify({ description: "new desc" }),
      }),
    );
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "soft_deleted",
    );
  });

  it("DELETE /v1/templates/:id returns 404 on already-soft-deleted template", async () => {
    const a = await seedAgent();
    const t = await createNamedTemplate(a.apiKey);
    await softDeleteTemplate(t.template_id);

    const res = await app.fetch(
      new Request(`http://t/v1/templates/${t.template_id}`, {
        method: "DELETE",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(404);
  });
});
