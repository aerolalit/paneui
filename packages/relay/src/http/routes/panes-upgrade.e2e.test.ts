// End-to-end tests for POST /v1/panes/:id/upgrade (#267 PR B).
//
// The route re-points a live pane's templateVersionId to another
// version of the same template. The schema-compat gate (PR A) refuses
// when the target schema narrows the old one; compat="force" overrides.
// Events on disk are unchanged — #268's per-event template_version stamp
// keeps them readable under their original schema.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import { generateApiKey, hashKey, keyPrefix } from "../../keys.js";

let testDb: TestDb;
let prisma: PrismaClient;
let app: Hono;

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

// Seed an agent + a template with v1, then a fresh pane pinned to v1.
async function seedPaneV1(opts?: { v1Schema?: object }): Promise<{
  apiKey: string;
  agentId: string;
  templateId: string;
  v1Id: string;
  paneId: string;
}> {
  const apiKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  const tmpl = await prisma.template.create({
    data: {
      ownerId: agent.id,
      name: "Test",
      slug: `tmpl-${randomBytes(3).toString("hex")}`,
      latestVersion: 1,
    },
  });
  const v1 = await prisma.templateVersion.create({
    data: {
      templateId: tmpl.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>v1</p>",
      eventSchema: opts?.v1Schema ?? {
        events: {
          "feed.logged": {
            emittedBy: ["page"],
            payload: {
              type: "object",
              properties: { value: { type: "number" } },
            },
          },
        },
      },
    },
  });
  const paneId = `pan_${randomBytes(8).toString("hex")}`;
  await prisma.pane.create({
    data: {
      id: paneId,
      agentId: agent.id,
      templateVersionId: v1.id,
      title: "Test pane",
      status: "open",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return {
    apiKey,
    agentId: agent.id,
    templateId: tmpl.id,
    v1Id: v1.id,
    paneId,
  };
}

async function publishV2(
  templateId: string,
  v2Schema: object,
): Promise<{ v2Id: string }> {
  const v2 = await prisma.templateVersion.create({
    data: {
      templateId,
      version: 2,
      templateType: "html-inline",
      templateSource: "<p>v2</p>",
      eventSchema: v2Schema,
    },
  });
  await prisma.template.update({
    where: { id: templateId },
    data: { latestVersion: 2 },
  });
  return { v2Id: v2.id };
}

function postUpgrade(
  paneId: string,
  apiKey: string,
  body: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/panes/${paneId}/upgrade`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /v1/panes/:id/upgrade — happy path", () => {
  it("re-points the pane to a compatible newer version", async () => {
    const { apiKey, templateId, v1Id, paneId } = await seedPaneV1();
    // v2 is a superset of v1: same payload shape, plus a new optional field.
    const { v2Id } = await publishV2(templateId, {
      events: {
        "feed.logged": {
          emittedBy: ["page"],
          payload: {
            type: "object",
            properties: {
              value: { type: "number" },
              note: { type: "string" },
            },
          },
        },
      },
    });

    const res = await postUpgrade(paneId, apiKey, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      template_version_id: string;
      template_version: number;
      upgraded: boolean;
      breaks: unknown[];
    };
    expect(body.upgraded).toBe(true);
    expect(body.template_version_id).toBe(v2Id);
    expect(body.template_version).toBe(2);
    expect(body.breaks).toEqual([]);

    // Pane row is re-pinned.
    const updated = await prisma.pane.findUnique({
      where: { id: paneId },
    });
    expect(updated!.templateVersionId).toBe(v2Id);
    expect(updated!.templateVersionId).not.toBe(v1Id);

    // A system event was appended.
    const sysEvents = await prisma.event.findMany({
      where: { paneId, type: "system.template.updated" },
    });
    expect(sysEvents).toHaveLength(1);
  });

  it("accepts an explicit template_version body field", async () => {
    const { apiKey, templateId, paneId } = await seedPaneV1();
    // Publish v2 AND v3; the caller pins v2 explicitly.
    await publishV2(templateId, {
      events: {
        "feed.logged": {
          emittedBy: ["page"],
          payload: { type: "object" },
        },
      },
    });
    await prisma.templateVersion.create({
      data: {
        templateId,
        version: 3,
        templateType: "html-inline",
        templateSource: "<p>v3</p>",
        eventSchema: {
          events: {
            "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
          },
        },
      },
    });
    await prisma.template.update({
      where: { id: templateId },
      data: { latestVersion: 3 },
    });

    const res = await postUpgrade(paneId, apiKey, {
      template_version: 2,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template_version: number };
    expect(body.template_version).toBe(2);
  });

  it("is a no-op when the pane is already on the target version", async () => {
    const { apiKey, paneId, v1Id } = await seedPaneV1();
    const res = await postUpgrade(paneId, apiKey, { template_version: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { upgraded: boolean };
    expect(body.upgraded).toBe(false);

    // No system event was appended for the no-op.
    const sysEvents = await prisma.event.findMany({
      where: { paneId, type: "system.template.updated" },
    });
    expect(sysEvents).toHaveLength(0);

    // Pane still on v1.
    const updated = await prisma.pane.findUnique({
      where: { id: paneId },
    });
    expect(updated!.templateVersionId).toBe(v1Id);
  });
});

describe("POST /v1/panes/:id/upgrade — schema-compat gate", () => {
  it("refuses 422 when the target narrows the schema (strict, default)", async () => {
    const { apiKey, templateId, paneId } = await seedPaneV1({
      v1Schema: {
        events: {
          "feed.logged": {
            emittedBy: ["page", "agent"],
            payload: { type: "object" },
          },
        },
      },
    });
    // v2 removes "agent" from emittedBy — a narrowing.
    await publishV2(templateId, {
      events: {
        "feed.logged": {
          emittedBy: ["page"],
          payload: { type: "object" },
        },
      },
    });

    const res = await postUpgrade(paneId, apiKey, {});
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: {
        code: string;
        details: { breaks: Array<{ path: string; message: string }> };
      };
    };
    expect(body.error.code).toBe("schema_incompatible_upgrade");
    expect(body.error.details.breaks.length).toBeGreaterThan(0);
    expect(body.error.details.breaks[0]!.path).toBe(
      "events.feed.logged.emittedBy",
    );
  });

  it("force=force applies the upgrade even with breaks", async () => {
    const { apiKey, templateId, paneId } = await seedPaneV1({
      v1Schema: {
        events: {
          "feed.logged": {
            emittedBy: ["page"],
            payload: { type: "object" },
          },
          "feed.unlogged": {
            emittedBy: ["page"],
            payload: { type: "object" },
          },
        },
      },
    });
    // v2 removes "feed.unlogged" — a breaking change.
    const { v2Id } = await publishV2(templateId, {
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });

    const res = await postUpgrade(paneId, apiKey, { compat: "force" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      upgraded: boolean;
      breaks: unknown[];
      compat: string;
    };
    expect(body.upgraded).toBe(true);
    expect(body.compat).toBe("force");
    expect(body.breaks.length).toBeGreaterThan(0);

    // Pane was re-pinned despite the break.
    const updated = await prisma.pane.findUnique({
      where: { id: paneId },
    });
    expect(updated!.templateVersionId).toBe(v2Id);

    // The system event recorded the breaks for the audit trail.
    const sysEvent = await prisma.event.findFirst({
      where: { paneId, type: "system.template.updated" },
    });
    const data = sysEvent!.data as { breaks: unknown[]; compat: string };
    expect(data.compat).toBe("force");
    expect(data.breaks.length).toBeGreaterThan(0);
  });
});

describe("POST /v1/panes/:id/upgrade — error envelopes", () => {
  it("404s on a pane the caller doesn't own", async () => {
    const owner = await seedPaneV1();
    // Create a second, unrelated agent and try to upgrade owner's pane.
    const intruderKey = generateApiKey();
    await prisma.agent.create({
      data: {
        name: "intruder",
        keyHash: hashKey(intruderKey),
        keyPrefix: keyPrefix(intruderKey),
      },
    });
    const res = await postUpgrade(owner.paneId, intruderKey, {});
    expect(res.status).toBe(404);
  });

  it("404s on an unknown pane id", async () => {
    const { apiKey } = await seedPaneV1();
    const res = await postUpgrade("pan_does_not_exist", apiKey, {});
    expect(res.status).toBe(404);
  });

  it("404s when the target version doesn't exist", async () => {
    const { apiKey, paneId } = await seedPaneV1();
    const res = await postUpgrade(paneId, apiKey, {
      template_version: 99,
    });
    expect(res.status).toBe(404);
  });

  it("410s on a closed pane", async () => {
    const { apiKey, paneId, templateId } = await seedPaneV1();
    await publishV2(templateId, {
      events: {
        "feed.logged": { emittedBy: ["page"], payload: { type: "object" } },
      },
    });
    await prisma.pane.update({
      where: { id: paneId },
      data: { status: "closed" },
    });
    const res = await postUpgrade(paneId, apiKey, {});
    expect(res.status).toBe(410);
  });

  it("400s on a malformed body (bad compat value)", async () => {
    const { apiKey, paneId } = await seedPaneV1();
    const res = await postUpgrade(paneId, apiKey, {
      compat: "yolo",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/panes/:id/upgrade — event history preservation (#268)", () => {
  it("leaves existing events on their original templateVersionId stamp", async () => {
    const { apiKey, templateId, v1Id, paneId, agentId } = await seedPaneV1();
    // Write an event under v1.
    await prisma.event.create({
      data: {
        paneId,
        authorKind: "agent",
        authorId: agentId,
        type: "feed.logged",
        data: { value: 5 },
        templateVersionId: v1Id,
        templateVersionNum: 1,
      },
    });

    // Publish v2 (superset), upgrade.
    const { v2Id } = await publishV2(templateId, {
      events: {
        "feed.logged": {
          emittedBy: ["page", "agent"],
          payload: {
            type: "object",
            properties: { value: { type: "number" } },
          },
        },
      },
    });
    const res = await postUpgrade(paneId, apiKey, {});
    expect(res.status).toBe(200);

    // The v1 event still carries the v1 stamp.
    const events = await prisma.event.findMany({
      where: { paneId, type: "feed.logged" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.templateVersionId).toBe(v1Id);
    expect(events[0]!.templateVersionNum).toBe(1);

    // The system event recording the upgrade carries the NEW version's
    // stamp (it was written after the re-pin).
    const sysEvent = await prisma.event.findFirst({
      where: { paneId, type: "system.template.updated" },
    });
    expect(sysEvent!.templateVersionId).toBe(v2Id);
    expect(sysEvent!.templateVersionNum).toBe(2);
  });
});
