// End-to-end test for the per-session WebSocket connection cap (abuse
// control B2).
//
// MAX_WS_CONNECTIONS_PER_SESSION is read from a config module singleton
// evaluated at import time, so it is set in beforeAll before the dynamic
// imports. A dedicated test file gives a clean module registry to evaluate
// it with a small cap.

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
import WebSocket from "ws";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";

let testDb: TestDb;
let prisma: PrismaClient;
let app: Hono;
let server: Server;
let port: number;
let hashKey: typeof import("../keys.js").hashKey;
let keyPrefix: typeof import("../keys.js").keyPrefix;

const CAP = 2;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.MAX_WS_CONNECTIONS_PER_SESSION = String(CAP);

  delete (globalThis as { prisma?: PrismaClient }).prisma;
  ({ default: prisma } = await import("../db.js"));
  await testDb.applyMigration(prisma);
  ({ hashKey, keyPrefix } = await import("../keys.js"));

  const { buildApp } = await import("../http/app.js");
  const { attachWs } = await import("./handler.js");
  app = buildApp();

  const { Readable } = await import("node:stream");
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
  attachWs(server);
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
});

// Sockets opened during a test; afterEach closes + drains them so no
// in-flight handleConnection() DB work outlives prisma.$disconnect().
const openSockets: WebSocket[] = [];

function track(ws: WebSocket): WebSocket {
  openSockets.push(ws);
  return ws;
}

async function closeAll(): Promise<void> {
  await Promise.all(
    openSockets.splice(0).map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) return resolve();
          ws.once("close", () => resolve());
          ws.close();
        }),
    ),
  );
  // Grace for the server-side 'close' handler (removeConnection + the
  // fire-and-forget participant.left insert) to finish before the next test.
  await new Promise((r) => setTimeout(r, 150));
}

afterAll(async () => {
  await closeAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise((r) => setTimeout(r, 150));
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedAgent(): Promise<string> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return apiKey;
}

async function createSession(
  apiKey: string,
): Promise<{ sessionId: string; agentToken: string }> {
  const res = await fetch(`http://localhost:${port}/v1/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      artifact: { type: "html-inline", source: "<html></html>" },
      schema: {
        events: {
          ping: { payload: { type: "object" }, emittedBy: ["page", "agent"] },
        },
      },
    }),
  });
  const body = (await res.json()) as {
    session_id: string;
    tokens: { agent: string };
  };
  return { sessionId: body.session_id, agentToken: body.tokens.agent };
}

// Open a socket and resolve once it is OPEN, or reject with the HTTP status
// when the upgrade is refused.
function open(sessionId: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${port}/v1/sessions/${sessionId}/stream?token=${token}`,
    );
    track(ws);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`upgrade rejected: ${res.statusCode}`));
    });
    ws.once("error", (err) => reject(err));
  });
}

describe("per-session WebSocket connection cap", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  afterEach(async () => {
    await closeAll();
  });

  it("rejects the connection past MAX_WS_CONNECTIONS_PER_SESSION", async () => {
    const apiKey = await seedAgent();
    const { sessionId, agentToken } = await createSession(apiKey);

    const open1 = await open(sessionId, agentToken);
    const open2 = await open(sessionId, agentToken);
    expect(open1.readyState).toBe(WebSocket.OPEN);
    expect(open2.readyState).toBe(WebSocket.OPEN);

    // The third concurrent socket exceeds the cap of 2 — upgrade refused 429.
    await expect(open(sessionId, agentToken)).rejects.toThrow(/429/);
  });

  it("frees a slot when a socket closes", async () => {
    const apiKey = await seedAgent();
    const { sessionId, agentToken } = await createSession(apiKey);

    const a = await open(sessionId, agentToken);
    await open(sessionId, agentToken);
    await expect(open(sessionId, agentToken)).rejects.toThrow(/429/);

    // Close one and wait for the server to deregister it.
    await new Promise<void>((resolve) => {
      a.once("close", () => resolve());
      a.close();
    });
    // Small grace for the server-side 'close' handler to run removeConnection.
    await new Promise((r) => setTimeout(r, 150));

    const c = await open(sessionId, agentToken);
    expect(c.readyState).toBe(WebSocket.OPEN);
  });
});
