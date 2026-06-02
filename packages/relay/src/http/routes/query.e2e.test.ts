// E2E tests for POST /v1/query — the agent-facing SQL endpoint (#355).
//
// The critical property under test is **scope isolation**: agent A's query
// must never see a row that belongs to agent B's owner-human. Several tests
// here deliberately stand up two agents with adjacent data, then assert one
// can't reach the other.

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedHuman(): Promise<{ humanId: string }> {
  const human = await prisma.human.create({
    data: {
      email: `q-${randomBytes(4).toString("hex")}@e2e.local`,
      verifiedAt: new Date(),
    },
  });
  return { humanId: human.id };
}

async function seedClaimedAgent(
  humanId: string,
): Promise<{ apiKey: string; agentId: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
      ownerHumanId: humanId,
      claimedAt: new Date(),
    },
  });
  return { apiKey, agentId: agent.id };
}

async function seedStandaloneAgent(): Promise<{
  apiKey: string;
  agentId: string;
}> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { apiKey, agentId: agent.id };
}

async function seedPaneOwnedByHuman(
  agentId: string,
  humanId: string,
  title: string,
): Promise<string> {
  const template = await prisma.template.create({
    data: { ownerId: agentId, latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
    },
  });
  const paneId = `pan_${randomBytes(8).toString("hex")}`;
  await prisma.pane.create({
    data: {
      id: paneId,
      agentId,
      ownerHumanId: humanId,
      templateVersionId: version.id,
      title,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return paneId;
}

async function seedPaneOwnedByAgent(
  agentId: string,
  title: string,
): Promise<string> {
  const template = await prisma.template.create({
    data: { ownerId: agentId, latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
    },
  });
  const paneId = `pan_${randomBytes(8).toString("hex")}`;
  await prisma.pane.create({
    data: {
      id: paneId,
      agentId,
      templateVersionId: version.id,
      title,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return paneId;
}

async function seedRecord(
  paneId: string,
  collectionName: string,
  data: object,
): Promise<void> {
  const coll = await prisma.recordCollection.upsert({
    where: { paneId_name: { paneId, name: collectionName } },
    create: { paneId, name: collectionName, seq: 0 },
    update: {},
  });
  await prisma.recordCollection.update({
    where: { id: coll.id },
    data: { seq: { increment: 1 } },
  });
  const refreshed = await prisma.recordCollection.findUnique({
    where: { id: coll.id },
  });
  await prisma.paneRecord.create({
    data: {
      collectionId: coll.id,
      recordKey: `rec_${randomBytes(6).toString("hex")}`,
      data,
      version: 1,
      seq: refreshed!.seq,
      authorKind: "agent",
      authorId: "test",
    },
  });
}

async function seedEvent(
  paneId: string,
  type: string,
  data: object,
): Promise<void> {
  const pane = await prisma.pane.findUnique({
    where: { id: paneId },
    select: { templateVersionId: true },
  });
  await prisma.event.create({
    data: {
      paneId,
      type,
      data,
      authorKind: "agent",
      authorId: "test",
      templateVersionId: pane!.templateVersionId,
    },
  });
}

function bearer(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

async function postQuery(apiKey: string, sql: string): Promise<Response> {
  return app.fetch(
    new Request("http://t/v1/query", {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify({ sql }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/query — auth", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/query — request shape", () => {
  it("returns 400 for an invalid body", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await app.fetch(
      new Request("http://t/v1/query", {
        method: "POST",
        headers: bearer(apiKey),
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when sql is missing", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await postQuery(apiKey, "");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects non-string sql", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await app.fetch(
      new Request("http://t/v1/query", {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({ sql: 42 }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/query — SELECT-only enforcement", () => {
  it("rejects INSERT", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await postQuery(apiKey, "INSERT INTO panes VALUES ('x')");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects multiple statements", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await postQuery(apiKey, "SELECT 1; SELECT 2");
    expect(res.status).toBe(400);
  });

  it("rejects ATTACH (a banned keyword inside a SELECT context)", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await postQuery(
      apiKey,
      "SELECT * FROM panes /* but also */ ATTACH '/etc/passwd'",
    );
    expect(res.status).toBe(400);
  });

  it("accepts SELECT, WITH, SHOW, DESCRIBE", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    for (const sql of [
      "SELECT 1",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "SHOW TABLES",
      "DESCRIBE panes",
    ]) {
      const res = await postQuery(apiKey, sql);
      expect(res.status, `sql=${sql}`).toBe(200);
    }
  });
});

describe("POST /v1/query — scope isolation", () => {
  it("an agent only sees panes its owner-human owns", async () => {
    // Alice has her own human + agent + pane.
    const alice = await seedHuman();
    const aliceAgent = await seedClaimedAgent(alice.humanId);
    await seedPaneOwnedByHuman(
      aliceAgent.agentId,
      alice.humanId,
      "alice's pane",
    );
    // Bob has his own human + agent + pane.
    const bob = await seedHuman();
    const bobAgent = await seedClaimedAgent(bob.humanId);
    await seedPaneOwnedByHuman(bobAgent.agentId, bob.humanId, "bob's pane");

    // Alice's agent queries panes — should see ONLY alice's row.
    const res = await postQuery(aliceAgent.apiKey, "SELECT title FROM panes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: string[];
      rows: string[][];
      scope: { kind: string; pane_count: number };
    };
    expect(body.columns).toEqual(["title"]);
    const titles = body.rows.map((r) => r[0]).sort();
    expect(titles).toEqual(["alice's pane"]);
    expect(body.scope).toEqual({ kind: "human", pane_count: 1 });
  });

  it("an agent's SELECT cannot reach another human's records via predicate-trickery", async () => {
    // Alice has a "todos" record. Bob has a "todos" record. They're not
    // related; the scope filter must hide bob's from alice's queries even
    // when alice's SQL doesn't explicitly filter by pane_id.
    const alice = await seedHuman();
    const aliceAgent = await seedClaimedAgent(alice.humanId);
    const aliceP = await seedPaneOwnedByHuman(
      aliceAgent.agentId,
      alice.humanId,
      "alice's pane",
    );
    await seedRecord(aliceP, "todos", { title: "alice-todo", done: false });

    const bob = await seedHuman();
    const bobAgent = await seedClaimedAgent(bob.humanId);
    const bobP = await seedPaneOwnedByHuman(
      bobAgent.agentId,
      bob.humanId,
      "bob's pane",
    );
    await seedRecord(bobP, "todos", { title: "bob-todo", done: false });

    const res = await postQuery(
      aliceAgent.apiKey,
      "SELECT data->>'title' AS title FROM records",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: string[][];
    };
    const titles = body.rows.map((r) => r[0]).sort();
    expect(titles).toEqual(["alice-todo"]);
  });

  it("an agent's SELECT cannot reach another human's events", async () => {
    const alice = await seedHuman();
    const aliceAgent = await seedClaimedAgent(alice.humanId);
    const aliceP = await seedPaneOwnedByHuman(
      aliceAgent.agentId,
      alice.humanId,
      "alice's pane",
    );
    await seedEvent(aliceP, "alice.event", { msg: "for-alice" });

    const bob = await seedHuman();
    const bobAgent = await seedClaimedAgent(bob.humanId);
    const bobP = await seedPaneOwnedByHuman(
      bobAgent.agentId,
      bob.humanId,
      "bob's pane",
    );
    await seedEvent(bobP, "bob.event", { msg: "for-bob" });

    const res = await postQuery(aliceAgent.apiKey, "SELECT type FROM events");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: string[][] };
    const types = body.rows.map((r) => r[0]).sort();
    expect(types).toEqual(["alice.event"]);
  });

  it("a standalone agent sees only its own (unclaimed) panes", async () => {
    const standalone = await seedStandaloneAgent();
    const standaloneP = await seedPaneOwnedByAgent(
      standalone.agentId,
      "standalone's pane",
    );
    await seedRecord(standaloneP, "todos", {
      title: "standalone-todo",
      done: false,
    });

    // A second standalone agent — must not see the first's data.
    const other = await seedStandaloneAgent();
    const otherP = await seedPaneOwnedByAgent(other.agentId, "other's pane");
    await seedRecord(otherP, "todos", { title: "other-todo", done: false });

    const res = await postQuery(
      standalone.apiKey,
      "SELECT data->>'title' AS t FROM records",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: string[][];
      scope: { kind: string; pane_count: number };
    };
    expect(body.rows.map((r) => r[0])).toEqual(["standalone-todo"]);
    expect(body.scope.kind).toBe("agent");
  });
});

describe("POST /v1/query — happy paths", () => {
  it("returns an empty result for an agent with no panes", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await postQuery(apiKey, "SELECT * FROM panes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: unknown[][];
      scope: { pane_count: number };
    };
    expect(body.rows).toEqual([]);
    expect(body.scope.pane_count).toBe(0);
  });

  it("aggregates work (COUNT, GROUP BY)", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    const p = await seedPaneOwnedByHuman(agent.agentId, humanId, "p");
    await seedEvent(p, "todo.added", { todoKey: "a" });
    await seedEvent(p, "todo.added", { todoKey: "b" });
    await seedEvent(p, "todo.toggled", { todoKey: "a" });

    const res = await postQuery(
      agent.apiKey,
      "SELECT type, COUNT(*) AS n FROM events GROUP BY 1 ORDER BY n DESC",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: string[];
      rows: [string, number][];
    };
    expect(body.columns).toEqual(["type", "n"]);
    expect(body.rows).toEqual([
      ["todo.added", 2],
      ["todo.toggled", 1],
    ]);
  });

  it("JSON column access via -> and ->> works", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    const p = await seedPaneOwnedByHuman(agent.agentId, humanId, "p");
    await seedRecord(p, "todos", { title: "buy milk", done: true });
    await seedRecord(p, "todos", { title: "ship pr", done: false });

    const res = await postQuery(
      agent.apiKey,
      "SELECT data->>'title' AS t FROM records WHERE (data->>'done')::boolean = false",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: [string][] };
    expect(body.rows.map((r) => r[0])).toEqual(["ship pr"]);
  });

  it("returns columns + rows shape and the scope envelope", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    await seedPaneOwnedByHuman(agent.agentId, humanId, "alpha");
    await seedPaneOwnedByHuman(agent.agentId, humanId, "beta");

    const res = await postQuery(
      agent.apiKey,
      "SELECT title FROM panes ORDER BY title",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: string[];
      rows: string[][];
      truncated: boolean;
      scope: { kind: "human"; pane_count: number };
      elapsed_ms: number;
    };
    expect(body.columns).toEqual(["title"]);
    expect(body.rows).toEqual([["alpha"], ["beta"]]);
    expect(body.truncated).toBe(false);
    expect(body.scope.kind).toBe("human");
    expect(body.scope.pane_count).toBe(2);
    expect(typeof body.elapsed_ms).toBe("number");
  });
});
