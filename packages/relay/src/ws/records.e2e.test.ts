// E2E test for pane-level record WS broadcast on collection delete (#531).
//
// Boots the real relay server, creates a pane with an inline record_schema,
// seeds three rows, opens a WS with ?subscribe_records=*, drains the replay
// (advancing the connection's per-collection replay cursor past every seeded
// row), then calls DELETE /v1/panes/:id/records/:collection and asserts a
// `record.delete` tombstone arrives for every live row.
//
// This is the coverage gap that let #531 ship green: the HTTP collection-delete
// e2e (`records.e2e.test.ts`) asserts DB state + status only and never connects
// a subscriber, so the broadcast path — where the regression lived — had no
// test. Before the fix the collection-delete tombstones reused each row's
// ORIGINAL seq, which can never exceed a caught-up subscriber's replay cursor,
// so the forwarder's `seq > lastReplaySeq` de-dup gate dropped every one.

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
// even when the test threw before its own `ws.close()` — see the long note in
// template-records.e2e.test.ts for why a leaked socket cascades into P2025 /
// an afterAll hang.
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
  for (const ws of openSockets.splice(0)) {
    try {
      ws.terminate();
    } catch {
      // already closed — nothing to do
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
});

const recordSchema = {
  $defs: {
    Comment: {
      type: "object",
      properties: { body: { type: "string", minLength: 1 } },
      required: ["body"],
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

async function seedAgent(): Promise<{ apiKey: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { apiKey };
}

// Create an inline pane carrying the record_schema above and return its id +
// agent token (used both for the WS connection and the record writes).
async function createPane(
  apiKey: string,
): Promise<{ paneId: string; agentToken: string }> {
  const res = await fetch(`http://localhost:${port}/v1/panes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      template: {
        name: "Records WS Test",
        source: "<html><body>hi</body></html>",
        type: "html-inline",
        record_schema: recordSchema,
      },
      title: "records ws e2e pane",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    pane_id: string;
    tokens: { agent: string };
  };
  return { paneId: body.pane_id, agentToken: body.tokens.agent };
}

async function writeRecord(
  apiKey: string,
  paneId: string,
  recordKey: string,
  bodyText: string,
): Promise<void> {
  const res = await fetch(
    `http://localhost:${port}/v1/panes/${paneId}/records/comments`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ record_key: recordKey, data: { body: bodyText } }),
    },
  );
  expect([200, 201]).toContain(res.status);
}

async function deleteCollection(apiKey: string, paneId: string): Promise<void> {
  const res = await fetch(
    `http://localhost:${port}/v1/panes/${paneId}/records/comments`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${apiKey}` },
    },
  );
  expect(res.status).toBe(204);
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
    ws.once("close", (code) => {
      clearTimeout(t);
      reject(new Error(`ws closed before open (code ${code})`));
    });
  });
}

// Open a WS to a pane with ?subscribe_records, retrying a transient slow/
// closed-before-open handshake under CI load (see template-records.e2e.test.ts
// for the full rationale). Binds a FrameQueue before awaiting open so a replay
// frame sent immediately after the 101 can't slip through.
async function connectAndOpen(
  paneId: string,
  token: string,
  subscribe: string,
  { attempts = 3, perAttemptTimeoutMs = 8000 } = {},
): Promise<{ ws: WebSocket; q: FrameQueue }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ws = new WebSocket(
      `ws://localhost:${port}/v1/panes/${paneId}/stream?token=${token}&subscribe_records=${encodeURIComponent(subscribe)}`,
    );
    openSockets.push(ws);
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

describe("pane-record collection-delete WS broadcast (#531)", () => {
  it(
    "delivers a record.delete tombstone for every live row to a caught-up subscriber",
    { timeout: 30000 },
    async () => {
      const { apiKey } = await seedAgent();
      const { paneId, agentToken } = await createPane(apiKey);

      // Seed three rows BEFORE connecting; the WS then replays all three,
      // advancing the connection's per-collection cursor to the highest seq.
      await writeRecord(apiKey, paneId, "k1", "one");
      await writeRecord(apiKey, paneId, "k2", "two");
      await writeRecord(apiKey, paneId, "k3", "three");

      const { ws, q } = await connectAndOpen(paneId, agentToken, "*");

      // Drain the replay: 3 upserts then the replay.complete sentinel. After
      // this the connection's lastReplaySeq for `comments` sits at the max row
      // seq — the exact condition that made the buggy tombstones invisible.
      const replayed: string[] = [];
      let sawReplayComplete = false;
      while (!sawReplayComplete) {
        const m = (await q.next(5000)) as {
          kind?: string;
          collection?: string;
          record?: { key: string };
        };
        if (m.kind === "record.upsert" && m.collection === "comments") {
          replayed.push(m.record!.key);
        } else if (
          m.kind === "record.replay.complete" &&
          m.collection === "comments"
        ) {
          sawReplayComplete = true;
        }
      }
      expect(replayed.sort()).toEqual(["k1", "k2", "k3"]);

      // Collection delete — every live row must arrive as a record.delete.
      await deleteCollection(apiKey, paneId);

      const tombstoned = new Set<string>();
      while (tombstoned.size < 3) {
        const m = (await q.until(
          (f) => f.kind === "record.delete" && f.collection === "comments",
        )) as { record?: { key: string; seq: number } };
        tombstoned.add(m.record!.key);
      }
      expect([...tombstoned].sort()).toEqual(["k1", "k2", "k3"]);

      ws.close();
    },
  );
});
