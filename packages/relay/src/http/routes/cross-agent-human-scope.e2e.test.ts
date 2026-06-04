// End-to-end tests for #283 — cross-agent same-human access scope.
//
// When two agents share the same `ownerHumanId`, they form a fungible
// fleet: any of them may read/write any pane or template owned by
// any of them. Unclaimed agents stay strictly self-scoped.

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
      // Disable the open-pane list + publish gates — this suite asserts
      // cross-agent visibility on GET /v1/templates and cross-agent publish
      // for templates created without panes. The gates have dedicated
      // coverage in template-open-pane-gates.e2e.test.ts.
      TEMPLATE_LIST_MIN_OPEN_PANES: "0",
      TEMPLATE_PUBLISH_MIN_OPEN_PANES: "0",
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

async function seedHuman(email: string) {
  return prisma.human.create({
    data: { email, verifiedAt: new Date() },
  });
}

async function seedAgent(ownerHumanId: string | null = null) {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const a = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
      ownerHumanId,
      claimedAt: ownerHumanId ? new Date() : null,
    },
  });
  return { id: a.id, apiKey };
}

async function seedPane(opts: {
  agentId: string;
  ownerHumanId: string | null;
  title?: string;
}) {
  const tpl = await prisma.template.create({
    data: { owner: { connect: { id: opts.agentId } }, name: "t" },
  });
  const tv = await prisma.templateVersion.create({
    data: {
      template: { connect: { id: tpl.id } },
      version: 1,
      templateType: "html-inline",
      templateSource: "<p/>",
    },
  });
  return prisma.pane.create({
    data: {
      id: `pan_${randomBytes(8).toString("hex")}`,
      agent: { connect: { id: opts.agentId } },
      ...(opts.ownerHumanId
        ? { ownerHuman: { connect: { id: opts.ownerHumanId } } }
        : {}),
      templateVersion: { connect: { id: tv.id } },
      title: opts.title ?? "t",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
}

describe("#283 cross-agent pane access", () => {
  it("GET /v1/panes lists same-human siblings' panes", async () => {
    const human = await seedHuman("alice@example.com");
    const a = await seedAgent(human.id);
    const b = await seedAgent(human.id);
    const stranger = await seedAgent(); // unclaimed

    await seedPane({
      agentId: a.id,
      ownerHumanId: human.id,
      title: "alice-A",
    });
    await seedPane({
      agentId: b.id,
      ownerHumanId: human.id,
      title: "alice-B",
    });
    await seedPane({
      agentId: stranger.id,
      ownerHumanId: null,
      title: "stranger",
    });

    const res = await app.fetch(
      new Request("http://t/v1/panes", {
        headers: { authorization: `Bearer ${b.apiKey}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ title: string | null }>;
    };
    const titles = body.items.map((i) => i.title).sort();
    expect(titles).toEqual(["alice-A", "alice-B"]);
    expect(body.items.length).toBe(2);
  });

  it("GET /v1/panes/:id succeeds for a sibling agent's pane", async () => {
    const human = await seedHuman("alice@example.com");
    const a = await seedAgent(human.id);
    const b = await seedAgent(human.id);
    const pane = await seedPane({
      agentId: a.id,
      ownerHumanId: human.id,
    });

    const res = await app.fetch(
      new Request(`http://t/v1/panes/${pane.id}`, {
        headers: { authorization: `Bearer ${b.apiKey}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("GET /v1/panes/:id returns forbidden for a different-human pane", async () => {
    const aliceHuman = await seedHuman("alice@example.com");
    const bobHuman = await seedHuman("bob@example.com");
    const aliceAgent = await seedAgent(aliceHuman.id);
    const bobAgent = await seedAgent(bobHuman.id);
    const alicePane = await seedPane({
      agentId: aliceAgent.id,
      ownerHumanId: aliceHuman.id,
    });

    const res = await app.fetch(
      new Request(`http://t/v1/panes/${alicePane.id}`, {
        headers: { authorization: `Bearer ${bobAgent.apiKey}` },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden_cross_human");
  });

  it("GET /v1/panes/:id keeps unclaimed-agent panes strictly self-scoped", async () => {
    // Two unclaimed (standalone) agents — neither has ownerHumanId.
    const a = await seedAgent();
    const b = await seedAgent();
    const pane = await seedPane({
      agentId: a.id,
      ownerHumanId: null,
    });

    const res = await app.fetch(
      new Request(`http://t/v1/panes/${pane.id}`, {
        headers: { authorization: `Bearer ${b.apiKey}` },
      }),
    );
    // No human owner on the pane → fall back to session_not_found
    // so we don't leak a "yes this exists" signal to random callers.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("session_not_found");
  });

  it("DELETE /v1/panes/:id works for a sibling agent's pane", async () => {
    const human = await seedHuman("alice@example.com");
    const a = await seedAgent(human.id);
    const b = await seedAgent(human.id);
    const pane = await seedPane({
      agentId: a.id,
      ownerHumanId: human.id,
    });

    const res = await app.fetch(
      new Request(`http://t/v1/panes/${pane.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${b.apiKey}` },
      }),
    );
    expect([200, 204]).toContain(res.status);
    // DELETE soft-closes the pane.
    const after = await prisma.pane.findUnique({
      where: { id: pane.id },
    });
    expect(after!.status).toBe("closed");
  });
});

describe("#283 cross-agent template access", () => {
  it("GET /v1/templates lists same-human siblings' templates", async () => {
    const human = await seedHuman("alice@example.com");
    const a = await seedAgent(human.id);
    const b = await seedAgent(human.id);
    const stranger = await seedAgent();

    await prisma.template.create({
      data: { ownerId: a.id, name: "alice-A", slug: "a-a" },
    });
    await prisma.template.create({
      data: { ownerId: b.id, name: "alice-B", slug: "a-b" },
    });
    await prisma.template.create({
      data: { ownerId: stranger.id, name: "stranger", slug: "s" },
    });

    const res = await app.fetch(
      new Request("http://t/v1/templates", {
        headers: { authorization: `Bearer ${b.apiKey}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      templates: Array<{ name: string | null }>;
    };
    const names = body.templates.map((t) => t.name).sort();
    expect(names).toEqual(["alice-A", "alice-B"]);
  });

  it("GET /v1/templates/:id resolves a sibling agent's template by id", async () => {
    const human = await seedHuman("alice@example.com");
    const a = await seedAgent(human.id);
    const b = await seedAgent(human.id);
    const tpl = await prisma.template.create({
      data: { ownerId: a.id, name: "shared", slug: "shared" },
    });

    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tpl.id}`, {
        headers: { authorization: `Bearer ${b.apiKey}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("POST /v1/templates/:id/versions accepts a sibling agent", async () => {
    const human = await seedHuman("alice@example.com");
    const a = await seedAgent(human.id);
    const b = await seedAgent(human.id);
    const tpl = await prisma.template.create({
      data: { ownerId: a.id, name: "shared", slug: "shared", latestVersion: 1 },
    });

    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tpl.id}/versions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${b.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source: "<p>v2</p>",
          type: "html-inline",
          event_schema: {
            events: {
              "form.submitted": {
                emittedBy: ["page"],
                payload: { type: "object" },
              },
            },
          },
        }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("a different human's agent still gets 404 on the same template", async () => {
    const aliceHuman = await seedHuman("alice@example.com");
    const bobHuman = await seedHuman("bob@example.com");
    const aliceAgent = await seedAgent(aliceHuman.id);
    const bobAgent = await seedAgent(bobHuman.id);
    const tpl = await prisma.template.create({
      data: { ownerId: aliceAgent.id, name: "private", slug: "private" },
    });

    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tpl.id}`, {
        headers: { authorization: `Bearer ${bobAgent.apiKey}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("publish accepts a same-human sibling agent", async () => {
    const human = await seedHuman("alice@example.com");
    const a = await seedAgent(human.id);
    const b = await seedAgent(human.id);
    const tpl = await prisma.template.create({
      data: { ownerId: a.id, name: "live", slug: "live" },
    });

    const res = await app.fetch(
      new Request(`http://t/v1/templates/${tpl.id}/publish`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${b.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.template.findUnique({
      where: { id: tpl.id },
    });
    expect(after!.publishedAt).not.toBeNull();
  });
});
