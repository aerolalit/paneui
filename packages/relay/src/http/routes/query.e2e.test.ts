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
    data: { ownerId: agentId, name: "Query Test", latestVersion: 1 },
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
    data: { ownerId: agentId, name: "Query Test", latestVersion: 1 },
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

// ---------------------------------------------------------------------------
// Phase 2 — per-collection / per-event-type materialized views.
// ---------------------------------------------------------------------------

// Schema with a `todos` collection (title TEXT, done BOOLEAN).
const todosRecordSchema = {
  $defs: {
    Todo: {
      type: "object",
      required: ["title", "done"],
      properties: {
        title: { type: "string", minLength: 1 },
        done: { type: "boolean" },
      },
    },
  },
  "x-pane-collections": {
    todos: {
      schema: { $ref: "#/$defs/Todo" },
      write: ["agent", "page"],
      delete: ["agent", "page"],
    },
  },
};

// Schema declaring two event types (legacy `events` shape).
const todoEventSchema = {
  events: {
    "todo.added": {
      emittedBy: ["agent"],
      payload: {
        type: "object",
        properties: {
          todoKey: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    "todo.toggled": {
      emittedBy: ["agent"],
      payload: {
        type: "object",
        properties: {
          todoKey: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
};

async function seedPaneWithSchemas(
  agentId: string,
  humanId: string,
  title: string,
  recordSchema: unknown,
  eventSchema: unknown,
): Promise<string> {
  const template = await prisma.template.create({
    data: { ownerId: agentId, name: "Query Test", latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
      recordSchema: recordSchema as object,
      eventSchema: eventSchema as object,
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

describe("POST /v1/query — Phase 2: per-collection views", () => {
  it("exposes each collection as a typed SQL table with the user-schema columns", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    const p = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p",
      todosRecordSchema,
      null,
    );
    await seedRecord(p, "todos", { title: "buy milk", done: false });
    await seedRecord(p, "todos", { title: "ship pr", done: true });

    // Agent-natural query: no JSON operators, no WHERE collection = …
    const res = await postQuery(
      agent.apiKey,
      "SELECT title, done FROM todos ORDER BY title",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: string[];
      rows: [string, boolean][];
    };
    expect(body.columns).toEqual(["title", "done"]);
    expect(body.rows).toEqual([
      ["buy milk", false],
      ["ship pr", true],
    ]);
  });

  it("exposes `_`-prefixed metadata + key + pane_id + pane_title columns", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    const p = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "my pane",
      todosRecordSchema,
      null,
    );
    await seedRecord(p, "todos", { title: "x", done: false });

    const res = await postQuery(
      agent.apiKey,
      "SELECT key, pane_id, pane_title, _version, _seq, _author, _deleted FROM todos",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      columns: string[];
      rows: unknown[][];
    };
    expect(body.columns).toEqual([
      "key",
      "pane_id",
      "pane_title",
      "_version",
      "_seq",
      "_author",
      "_deleted",
    ]);
    expect(body.rows.length).toBe(1);
    const [, paneIdCell, paneTitleCell, version, , author, deleted] =
      body.rows[0]!;
    expect(paneIdCell).toBe(p);
    expect(paneTitleCell).toBe("my pane");
    expect(version).toBe(1);
    expect(author).toBe("agent");
    expect(deleted).toBe(false);
  });

  it("merges the same collection across panes when schemas agree", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    const p1 = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p1",
      todosRecordSchema,
      null,
    );
    const p2 = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p2",
      todosRecordSchema,
      null,
    );
    await seedRecord(p1, "todos", { title: "from-p1", done: false });
    await seedRecord(p2, "todos", { title: "from-p2", done: true });

    const res = await postQuery(
      agent.apiKey,
      "SELECT title, pane_title FROM todos ORDER BY title",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: [string, string][] };
    expect(body.rows).toEqual([
      ["from-p1", "p1"],
      ["from-p2", "p2"],
    ]);
  });

  it("exposes _deleted flag so tombstones are visible without leaking by default", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    const p = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p",
      todosRecordSchema,
      null,
    );
    await seedRecord(p, "todos", { title: "alive", done: false });

    // Insert a soft-deleted record by hand to test the _deleted flag.
    const coll = await prisma.recordCollection.findFirst({
      where: { paneId: p, name: "todos" },
    });
    await prisma.recordCollection.update({
      where: { id: coll!.id },
      data: { seq: { increment: 1 } },
    });
    const seqAfter = (await prisma.recordCollection.findUnique({
      where: { id: coll!.id },
    }))!.seq;
    await prisma.paneRecord.create({
      data: {
        collectionId: coll!.id,
        recordKey: `rec_${randomBytes(6).toString("hex")}`,
        data: { title: "dead", done: false },
        version: 1,
        seq: seqAfter,
        authorKind: "agent",
        authorId: "test",
        deletedAt: new Date(),
      },
    });

    const res = await postQuery(
      agent.apiKey,
      "SELECT title, _deleted FROM todos ORDER BY title",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: [string, boolean][] };
    expect(body.rows).toEqual([
      ["alive", false],
      ["dead", true],
    ]);
  });

  it("exposes events as separate tables, dotted types slugified to underscores", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    const p = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p",
      null,
      todoEventSchema,
    );
    await seedEvent(p, "todo.added", { todoKey: "rec_a", message: "added a" });
    await seedEvent(p, "todo.added", { todoKey: "rec_b", message: "added b" });
    await seedEvent(p, "todo.toggled", {
      todoKey: "rec_a",
      message: "done",
    });

    const r1 = await postQuery(
      agent.apiKey,
      "SELECT todoKey, message FROM todo_added ORDER BY todoKey",
    );
    expect(r1.status).toBe(200);
    expect((await r1.json()) as { rows: [string, string][] }).toMatchObject({
      rows: [
        ["rec_a", "added a"],
        ["rec_b", "added b"],
      ],
    });

    const r2 = await postQuery(
      agent.apiKey,
      "SELECT COUNT(*) AS n FROM todo_toggled",
    );
    expect(r2.status).toBe(200);
    expect((await r2.json()) as { rows: [number][] }).toMatchObject({
      rows: [[1]],
    });
  });

  it("type conflict across panes for the same collection raises view_conflict", async () => {
    const conflicting = {
      $defs: {
        Todo: {
          type: "object",
          properties: {
            // `done` is integer here vs boolean in todosRecordSchema → conflict
            done: { type: "integer" },
            title: { type: "string" },
          },
        },
      },
      "x-pane-collections": {
        todos: {
          schema: { $ref: "#/$defs/Todo" },
          write: ["agent"],
          delete: ["agent"],
        },
      },
    };
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p1",
      todosRecordSchema,
      null,
    );
    await seedPaneWithSchemas(agent.agentId, humanId, "p2", conflicting, null);

    const res = await postQuery(agent.apiKey, "SELECT * FROM todos");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("view_conflict");
  });

  it("back-compat: the generic records / events views still work alongside per-collection views", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    const p = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p",
      todosRecordSchema,
      null,
    );
    await seedRecord(p, "todos", { title: "phase-1-shape", done: false });

    const legacy = await postQuery(
      agent.apiKey,
      "SELECT data->>'title' AS t FROM records WHERE collection = 'todos'",
    );
    expect(legacy.status).toBe(200);
    expect((await legacy.json()) as { rows: [string][] }).toMatchObject({
      rows: [["phase-1-shape"]],
    });
  });

  it("SHOW TABLES lists the per-collection + per-event-type views", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p",
      todosRecordSchema,
      todoEventSchema,
    );

    const res = await postQuery(agent.apiKey, "SHOW TABLES");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: string[][] };
    const names = body.rows.map((r) => r[0]);
    expect(names).toEqual(
      expect.arrayContaining(["panes", "records", "events"]),
    );
    expect(names).toEqual(expect.arrayContaining(["todos"]));
    expect(names).toEqual(
      expect.arrayContaining(["todo_added", "todo_toggled"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — --pane scope + lazy materialization + interrupt timeout
// ---------------------------------------------------------------------------

async function postQueryWith(
  apiKey: string,
  body: { sql: string; pane_id?: string },
): Promise<Response> {
  return app.fetch(
    new Request("http://t/v1/query", {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /v1/query — Phase 3: pane_id scope", () => {
  it("narrows the scope to a single pane when pane_id is passed", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    const p1 = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p1",
      todosRecordSchema,
      null,
    );
    const p2 = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p2",
      todosRecordSchema,
      null,
    );
    await seedRecord(p1, "todos", { title: "from-p1", done: false });
    await seedRecord(p2, "todos", { title: "from-p2", done: true });

    const res = await postQueryWith(agent.apiKey, {
      sql: "SELECT title FROM todos ORDER BY title",
      pane_id: p1,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: string[][];
      scope: { pane_count: number };
    };
    expect(body.rows.map((r) => r[0])).toEqual(["from-p1"]);
    expect(body.scope.pane_count).toBe(1);
  });

  it("resolves view_conflict by scoping to a single pane", async () => {
    const conflicting = {
      $defs: {
        Todo: {
          type: "object",
          properties: {
            done: { type: "integer" },
            title: { type: "string" },
          },
        },
      },
      "x-pane-collections": {
        todos: {
          schema: { $ref: "#/$defs/Todo" },
          write: ["agent"],
          delete: ["agent"],
        },
      },
    };
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    const p1 = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p1",
      todosRecordSchema,
      null,
    );
    await seedPaneWithSchemas(agent.agentId, humanId, "p2", conflicting, null);
    await seedRecord(p1, "todos", { title: "ok", done: false });

    const conflictRes = await postQueryWith(agent.apiKey, {
      sql: "SELECT title FROM todos",
    });
    expect(conflictRes.status).toBe(400);
    expect(
      ((await conflictRes.json()) as { error: { code: string } }).error.code,
    ).toBe("view_conflict");

    const okRes = await postQueryWith(agent.apiKey, {
      sql: "SELECT title FROM todos",
      pane_id: p1,
    });
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as { rows: string[][] };
    expect(body.rows).toEqual([["ok"]]);
  });

  it("returns empty result when pane_id points outside the caller's scope (no enumeration oracle)", async () => {
    const alice = await seedHuman();
    const aliceAgent = await seedClaimedAgent(alice.humanId);
    await seedPaneOwnedByHuman(aliceAgent.agentId, alice.humanId, "alice's");

    const bob = await seedHuman();
    const bobAgent = await seedClaimedAgent(bob.humanId);
    const bobP = await seedPaneOwnedByHuman(
      bobAgent.agentId,
      bob.humanId,
      "bob's",
    );
    await seedRecord(bobP, "todos", { title: "stealth", done: false });

    const res = await postQueryWith(aliceAgent.apiKey, {
      sql: "SELECT * FROM panes",
      pane_id: bobP,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: unknown[][];
      scope: { pane_count: number };
    };
    expect(body.rows).toEqual([]);
    expect(body.scope.pane_count).toBe(0);
  });

  it("rejects pane_id that doesn't look like a pane id (400)", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await postQueryWith(apiKey, {
      sql: "SELECT 1",
      pane_id: "not-a-pane-id",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/query — Phase 3: lazy materialization", () => {
  it("does not error on view_conflict in a collection the query doesn't reference", async () => {
    // Two panes both declare `todos` but with conflicting types. A third
    // pane declares `comments`. A query against `comments` must not be
    // tripped up by the unrelated `todos` conflict — lazy materialization
    // only builds the views the query references.
    const commentsOnly = {
      $defs: {
        Comment: {
          type: "object",
          required: ["body"],
          properties: { body: { type: "string" } },
        },
      },
      "x-pane-collections": {
        comments: {
          schema: { $ref: "#/$defs/Comment" },
          write: ["agent"],
          delete: ["agent"],
        },
      },
    };
    const conflictingTodos = {
      $defs: {
        Todo: {
          type: "object",
          properties: {
            done: { type: "integer" },
            title: { type: "string" },
          },
        },
      },
      "x-pane-collections": {
        todos: {
          schema: { $ref: "#/$defs/Todo" },
          write: ["agent"],
          delete: ["agent"],
        },
      },
    };
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p1",
      todosRecordSchema,
      null,
    );
    const pComments = await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p2",
      commentsOnly,
      null,
    );
    await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p3",
      conflictingTodos,
      null,
    );
    await seedRecord(pComments, "comments", { body: "hello" });

    // Touching `comments` only → must succeed even though `todos` conflicts.
    const ok = await postQuery(agent.apiKey, "SELECT body FROM comments");
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { rows: [string][] }).toMatchObject({
      rows: [["hello"]],
    });

    // Sanity: touching `todos` directly still surfaces the conflict.
    const conflict = await postQuery(agent.apiKey, "SELECT * FROM todos");
    expect(conflict.status).toBe(400);
    expect(
      ((await conflict.json()) as { error: { code: string } }).error.code,
    ).toBe("view_conflict");
  });

  it("SHOW TABLES still surfaces every materialized view (introspection forces eager mode)", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    await seedPaneWithSchemas(
      agent.agentId,
      humanId,
      "p",
      todosRecordSchema,
      todoEventSchema,
    );
    const res = await postQuery(agent.apiKey, "SHOW TABLES");
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { rows: string[][] }).rows.map(
      (r) => r[0],
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "panes",
        "records",
        "events",
        "todos",
        "todo_added",
        "todo_toggled",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// TIMESTAMP serialization — DuckDB returns DuckDBTimestampValue etc. (with
// BigInt internals), which JSON.stringify can't handle. The engine's
// normalizeCell now converts these to strings. Without the fix any SELECT
// on a TIMESTAMP / DATE / TIME column on `panes`, `events`, or a per-
// collection view returns 500.
// ---------------------------------------------------------------------------

describe("POST /v1/query — TIMESTAMP / DATE / TIME serialization", () => {
  it("selecting a TIMESTAMP literal returns an ISO-8601 string", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await postQuery(
      apiKey,
      "SELECT TIMESTAMP '2026-06-02 12:34:56.789' AS ts",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: [string][] };
    expect(body.rows[0]![0]).toBe("2026-06-02T12:34:56.789Z");
  });

  it("selecting a DATE literal returns the canonical YYYY-MM-DD string", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await postQuery(apiKey, "SELECT DATE '2026-06-02' AS d");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: [string][] };
    expect(body.rows[0]![0]).toBe("2026-06-02");
  });

  it("selecting a TIME literal returns the canonical HH:MM:SS string", async () => {
    const { humanId } = await seedHuman();
    const { apiKey } = await seedClaimedAgent(humanId);
    const res = await postQuery(apiKey, "SELECT TIME '12:34:56' AS t");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: [string][] };
    expect(body.rows[0]![0]).toBe("12:34:56");
  });

  it("the panes view's created_at + expires_at round-trip as ISO-8601", async () => {
    const { humanId } = await seedHuman();
    const agent = await seedClaimedAgent(humanId);
    await seedPaneOwnedByHuman(agent.agentId, humanId, "with timestamps");

    const res = await postQuery(
      agent.apiKey,
      "SELECT title, created_at, expires_at FROM panes",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: [string, string, string][] };
    expect(body.rows.length).toBe(1);
    const [, createdAt, expiresAt] = body.rows[0]!;
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(new Date(createdAt).toISOString().slice(0, 10)).toBe(
      createdAt.slice(0, 10),
    );
  });
});
