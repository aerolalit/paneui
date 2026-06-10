// E2E test for template-level record WS broadcast + replay-on-connect.
//
// Boots the real relay server, creates a template with template_record_schema,
// pre-seeds two template records, creates two panes derived from that template,
// opens a WS connection to one of them with ?subscribe_template_records=*,
// asserts the replay arrives, then writes a third template record via HTTP and
// asserts both panes' WS connections receive the live delta.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import WebSocket from "ws";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";
import { loadConfig } from "../config.js";
import { hashKey, keyPrefix } from "../keys.js";
import { buildApp } from "../http/app.js";
import { createRateLimiter } from "../http/rate-limit.js";
import { attachWs } from "./handler.js";

let testDb: TestDb;
let prisma: PrismaClient;
let app: Hono;
let server: Server;
let port: number;

// Every WebSocket a test opens is tracked here so `afterEach` can tear it down
// even when the test threw before its own `ws.close()`. A leaked socket was the
// root of this suite's CI flake: if `waitOpen`/`until` rejected under load, the
// test bailed with the socket still live, and then (1) the next test's
// `beforeEach` truncate raced the lingering socket's server-side writes → P2025,
// and (2) the open connection kept `server.close()` from ever calling back, so
// `afterAll` hit its 30s hook timeout. Closing every socket while its rows still
// exist (afterEach runs before the next beforeEach) removes both failure modes.
const openSockets: WebSocket[] = [];

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);

  const config = loadConfig();
  const generalLimiter = createRateLimiter(
    config.RATE_LIMIT,
    config.RATE_LIMIT_WINDOW_SECONDS * 1000,
  );
  app = buildApp(config, prisma, generalLimiter);
  server = createServer(async (req, res) => {
    const url = `http://localhost:${port}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const method = req.method ?? "GET";
    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      init.body = Buffer.concat(chunks);
    }
    const response = await app.fetch(new Request(url, init));
    res.statusCode = response.status;
    response.headers.forEach((val, key) => res.setHeader(key, val));
    if (response.body) {
      Readable.fromWeb(response.body as never).pipe(res);
    } else {
      res.end();
    }
  });
  attachWs(server, { config, prisma, generalLimiter });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  // Force-drop any still-live connections so server.close() can't hang waiting
  // on a lingering socket (Node 18.2+). Without this, one leaked WS turns the
  // teardown into a 30s hook timeout. `server?.` guards the case where beforeAll
  // itself failed and never assigned `server`.
  server?.closeAllConnections?.();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  await testDb.cleanup();
}, 30_000);

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

afterEach(async () => {
  // Terminate every socket this test opened — `terminate()` (not `close()`) so a
  // half-open handshake is dropped immediately — then yield a tick so the
  // server-side close handlers finish their final writes BEFORE the next
  // beforeEach truncates the tables. This is what keeps the leak from
  // cascading into P2025 / the afterAll hang.
  for (const ws of openSockets.splice(0)) {
    try {
      ws.terminate();
    } catch {
      // already closed — nothing to do
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
});

const templateRecordSchema = {
  $defs: {
    Question: {
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
      required: ["text"],
    },
  },
  "x-pane-collections": {
    questions: {
      schema: { $ref: "#/$defs/Question" },
      // The shared shape validator requires write/delete arrays. Template
      // records are owner-only at the route layer (HTTP auth), so we set
      // the principals to "agent" — agents acting as the owner — and
      // depend on the route's owner-scope check, not the schema, for
      // authorization. (A page principal would never be admitted here
      // because pages have no write route to template-records.)
      write: ["agent"],
      delete: ["agent"],
    },
  },
};

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { id: agent.id, apiKey };
}

async function createTemplate(apiKey: string): Promise<{ templateId: string }> {
  const res = await fetch(`http://localhost:${port}/v1/templates`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Survey",
      source: "<html><body>hi</body></html>",
      type: "html-inline",
      template_record_schema: templateRecordSchema,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { template_id: string };
  return { templateId: body.template_id };
}

async function createPaneFromTemplate(
  apiKey: string,
  templateId: string,
): Promise<{ paneId: string; agentToken: string }> {
  const res = await fetch(`http://localhost:${port}/v1/panes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      template: { id: templateId },
      title: "derived pane",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    pane_id: string;
    tokens: { agent: string };
  };
  return { paneId: body.pane_id, agentToken: body.tokens.agent };
}

async function upsertTemplateRecord(
  apiKey: string,
  templateId: string,
  recordKey: string,
  text: string,
): Promise<void> {
  const res = await fetch(
    `http://localhost:${port}/v1/templates/${templateId}/template-records/questions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ record_key: recordKey, data: { text } }),
    },
  );
  expect([200, 201]).toContain(res.status);
}

function connect(paneId: string, token: string, subscribe: string): WebSocket {
  const ws = new WebSocket(
    `ws://localhost:${port}/v1/panes/${paneId}/stream?token=${token}&subscribe_template_records=${encodeURIComponent(subscribe)}`,
  );
  // Track for afterEach teardown so a thrown test never leaks the socket.
  openSockets.push(ws);
  return ws;
}

class FrameQueue {
  private buf: unknown[] = [];
  private waiters: Array<(v: unknown) => void> = [];
  constructor(ws: WebSocket) {
    ws.on("message", (raw) => {
      const v = JSON.parse(raw.toString());
      const w = this.waiters.shift();
      if (w) w(v);
      else this.buf.push(v);
    });
  }
  next(timeoutMs = 10000): Promise<unknown> {
    if (this.buf.length > 0) return Promise.resolve(this.buf.shift()!);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
      this.waiters.push((v) => {
        clearTimeout(t);
        resolve(v);
      });
    });
  }
  async until(
    predicate: (m: { kind?: string; collection?: string }) => boolean,
    timeoutMs = 10000,
  ): Promise<{ kind?: string; collection?: string; [k: string]: unknown }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = (await this.next(deadline - Date.now())) as {
        kind?: string;
        collection?: string;
      };
      if (predicate(m)) return m as never;
    }
    throw new Error("until predicate not matched within timeout");
  }
}

// Resolve once the socket opens; reject on a per-attempt budget, a transport
// error, or a close-before-open. This is deliberately a *short* per-attempt
// timeout (not the old single 20s wait) — `connectAndOpen` below wraps it in a
// bounded retry, so a single starved handshake no longer fails the test.
function waitOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
    // A handshake that closes before "open" should fail fast with a clear
    // reason rather than wait out the full timeout.
    ws.once("close", (code) => {
      clearTimeout(t);
      reject(new Error(`ws closed before open (code ${code})`));
    });
  });
}

// Open a WS to a pane and wait for it to come up, tolerating a transient slow
// handshake under CI load.
//
// Why retry instead of just a big timeout: the sqlite e2e job runs this file
// alongside ~60 others under a bounded forks pool on a 2-vCPU runner. The relay
// uses the synchronous better-sqlite3 adapter on a single shared connection, so
// when a fork's event loop is starved the *pre-upgrade auth chain*
// (rate-limit → pane lookup → bearer resolve → participant update, all awaited
// before the 101 is written) can blow past any fixed wall-clock budget even
// though its real CPU work is milliseconds. That surfaces to the client as
// "ws open timeout" (or, if the server tears the half-open socket down,
// "ws closed before open") — not a hang, and the next handshake succeeds. So
// on a per-attempt timeout we terminate the dead socket, drop it from the
// teardown-tracking array (a retried socket must not leak), and reconnect; only
// repeated failures across all attempts fail the test.
//
// Budget: attempts × perAttemptTimeoutMs stays inside each call site's test
// timeout (default 5s tests get an explicit larger budget; the two-pane test
// already runs at 60s).
// Returns the open socket *and* a FrameQueue already bound to it. The queue's
// `message` listener is attached on the same socket before this resolves, so a
// replay frame the server sends immediately after the 101 can't slip through
// the gap between "open" and the caller wiring up its own listener. On retry
// the previous socket (and its dead queue) is discarded and a fresh pair is
// built on the new socket, so the returned queue always belongs to the live
// connection.
async function connectAndOpen(
  paneId: string,
  token: string,
  subscribe: string,
  { attempts = 3, perAttemptTimeoutMs = 8000 } = {},
): Promise<{ ws: WebSocket; q: FrameQueue }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ws = connect(paneId, token, subscribe);
    // Bind the queue before awaiting open so no early frame is dropped.
    const q = new FrameQueue(ws);
    try {
      await waitOpen(ws, perAttemptTimeoutMs);
      return { ws, q };
    } catch (err) {
      lastErr = err;
      try {
        ws.terminate();
      } catch {
        // already gone — nothing to do
      }
      const idx = openSockets.indexOf(ws);
      if (idx !== -1) openSockets.splice(idx, 1);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`ws failed to open after ${attempts} attempts`);
}

describe("template-record WS broadcast", () => {
  it(
    "replays pre-seeded template records on connect",
    { timeout: 30000 },
    async () => {
      const { apiKey } = await seedAgent();
      const { templateId } = await createTemplate(apiKey);
      await upsertTemplateRecord(apiKey, templateId, "q1", "first?");
      await upsertTemplateRecord(apiKey, templateId, "q2", "second?");

      const { paneId, agentToken } = await createPaneFromTemplate(
        apiKey,
        templateId,
      );
      const { ws, q } = await connectAndOpen(paneId, agentToken, "*");

      const upserts: Array<{ key: string }> = [];
      let sawReplayComplete = false;
      const seenKinds: string[] = [];
      while (!sawReplayComplete) {
        const m = (await q.next(5000)) as {
          kind?: string;
          type?: string;
          collection?: string;
          record?: { key: string };
        };
        seenKinds.push(m.kind ?? m.type ?? "event");
        if (
          m.kind === "template-record.upsert" &&
          m.collection === "questions"
        ) {
          upserts.push({ key: m.record!.key });
        } else if (
          m.kind === "template-record.replay.complete" &&
          m.collection === "questions"
        ) {
          sawReplayComplete = true;
        }
      }
      ws.close();
      expect(upserts.map((u) => u.key).sort()).toEqual(["q1", "q2"]);
      void seenKinds; // available for debugging
    },
  );

  it(
    "broadcasts a live template-record upsert to a derived pane WS",
    { timeout: 30000 },
    async () => {
      const { apiKey } = await seedAgent();
      const { templateId } = await createTemplate(apiKey);
      const { paneId, agentToken } = await createPaneFromTemplate(
        apiKey,
        templateId,
      );

      const { ws, q } = await connectAndOpen(paneId, agentToken, "*");

      // Drain replay sentinel for empty collection.
      await q.until(
        (m) =>
          m.kind === "template-record.replay.complete" &&
          m.collection === "questions",
      );

      // Live write — should arrive on the WS.
      await upsertTemplateRecord(apiKey, templateId, "qlive", "live one");

      const delta = (await q.until(
        (m) =>
          m.kind === "template-record.upsert" && m.collection === "questions",
      )) as { record?: { key: string; data: { text: string } } };
      expect(delta.record!.key).toBe("qlive");
      expect(delta.record!.data.text).toBe("live one");
      ws.close();
    },
  );

  // This two-pane fan-out test used to be the suite's CI flake (on the sqlite
  // e2e job, where it runs): a leaked socket from a thrown assertion let the
  // next beforeEach truncate race the lingering connection's writes (P2025) and
  // hung afterAll's server.close(). That's fixed at the source now — every
  // socket is terminated in afterEach before the next truncate, and afterAll
  // force-drops connections — so this no longer needs a skip. Kept sqlite-only
  // (the single-pane broadcast test already exercises the path on every DB);
  // running the heavier dual-socket shape on one engine is enough.
  const isPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");
  it.skipIf(isPostgres)(
    "broadcasts to BOTH derived panes simultaneously",
    { timeout: 60000 },
    async () => {
      const { apiKey } = await seedAgent();
      const { templateId } = await createTemplate(apiKey);
      const a = await createPaneFromTemplate(apiKey, templateId);
      const b = await createPaneFromTemplate(apiKey, templateId);

      // Open both sockets concurrently so the two handshakes share one wait
      // window instead of stacking two sequential waits (which doubled the odds
      // a single starved handshake blew the budget). Each side independently
      // retries on a transient slow/closed-before-open handshake.
      const [{ ws: wsA, q: qA }, { ws: wsB, q: qB }] = await Promise.all([
        connectAndOpen(a.paneId, a.agentToken, "*"),
        connectAndOpen(b.paneId, b.agentToken, "*"),
      ]);
      await qA.until(
        (m) =>
          m.kind === "template-record.replay.complete" &&
          m.collection === "questions",
      );
      await qB.until(
        (m) =>
          m.kind === "template-record.replay.complete" &&
          m.collection === "questions",
      );

      await upsertTemplateRecord(apiKey, templateId, "q_both", "for everyone");

      const deltaA = (await qA.until(
        (m) =>
          m.kind === "template-record.upsert" && m.collection === "questions",
      )) as { record?: { key: string } };
      const deltaB = (await qB.until(
        (m) =>
          m.kind === "template-record.upsert" && m.collection === "questions",
      )) as { record?: { key: string } };
      expect(deltaA.record!.key).toBe("q_both");
      expect(deltaB.record!.key).toBe("q_both");
      wsA.close();
      wsB.close();
    },
  );

  it("rejects subscribe_template_records=undeclared with 400", async () => {
    const { apiKey } = await seedAgent();
    const { templateId } = await createTemplate(apiKey);
    const { paneId, agentToken } = await createPaneFromTemplate(
      apiKey,
      templateId,
    );
    const ws = new WebSocket(
      `ws://localhost:${port}/v1/panes/${paneId}/stream?token=${agentToken}&subscribe_template_records=nope`,
    );
    const status: number = await new Promise((resolve) => {
      ws.once("unexpected-response", (_req, res) =>
        resolve(res.statusCode ?? 0),
      );
      ws.once("error", () => resolve(0));
    });
    expect(status).toBe(400);
  });
});
