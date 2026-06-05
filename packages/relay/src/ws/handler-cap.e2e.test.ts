// End-to-end test for the per-pane WebSocket connection cap (abuse
// control B2).
//
// MAX_WS_CONNECTIONS_PER_PANE is supplied via the config injected into
// buildApp()/attachWs(), so the small cap is just passed straight to
// loadConfig() — no module-singleton juggling required.

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

const CAP = 2;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);

  // This file exercises the per-pane connection cap by opening many
  // upgrades from one (loopback) IP. RATE_LIMIT=0 disables the general per-IP
  // rate limiter so it doesn't fire first — RATE_LIMIT is covered by its own
  // test.
  const config = loadConfig({
    DATABASE_URL: testDb.dbUrl,
    MAX_WS_CONNECTIONS_PER_PANE: String(CAP),
    RATE_LIMIT: "0",
  });
  // The same shared general limiter the relay hands to both buildApp() and
  // attachWs() — disabled here via RATE_LIMIT=0.
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
        name: "Test template",
        type: "html-inline",
        source: "<html></html>",
        event_schema: {
          events: {
            ping: {
              payload: { type: "object" },
              emittedBy: ["page", "agent"],
            },
          },
        },
      },
      title: "Test pane",
    }),
  });
  const body = (await res.json()) as {
    pane_id: string;
    tokens: { agent: string };
  };
  return { paneId: body.pane_id, agentToken: body.tokens.agent };
}

// Open a socket and resolve once it is OPEN, or reject with the HTTP status
// when the upgrade is refused.
function open(paneId: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${port}/v1/panes/${paneId}/stream?token=${token}`,
    );
    track(ws);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`upgrade rejected: ${res.statusCode}`));
    });
    ws.once("error", (err) => reject(err));
  });
}

describe("per-pane WebSocket connection cap", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  afterEach(async () => {
    await closeAll();
  });

  it("rejects the connection past MAX_WS_CONNECTIONS_PER_PANE", async () => {
    const apiKey = await seedAgent();
    const { paneId, agentToken } = await createPane(apiKey);

    const open1 = await open(paneId, agentToken);
    const open2 = await open(paneId, agentToken);
    expect(open1.readyState).toBe(WebSocket.OPEN);
    expect(open2.readyState).toBe(WebSocket.OPEN);

    // The third concurrent socket exceeds the cap of 2 — upgrade refused 429.
    await expect(open(paneId, agentToken)).rejects.toThrow(/429/);
  });

  it("frees a slot when a socket closes", async () => {
    const apiKey = await seedAgent();
    const { paneId, agentToken } = await createPane(apiKey);

    const a = await open(paneId, agentToken);
    await open(paneId, agentToken);
    await expect(open(paneId, agentToken)).rejects.toThrow(/429/);

    // Close one and wait for the server to deregister it.
    await new Promise<void>((resolve) => {
      a.once("close", () => resolve());
      a.close();
    });

    // Poll-until-slot-is-free instead of a fixed grace timer. The previous
    // `setTimeout(150)` was a guess at how long the server's WS 'close'
    // handler needs to run `removeConnection` — on a busy postgres CI runner
    // that budget isn't always enough, and a 429 leaks through (issue #145).
    // Re-attempt the open with a deadline; treat 429s as "slot not yet free,
    // try again" and pane anything else verbatim.
    const c = await openWhenSlotFree(paneId, agentToken, 2000);
    expect(c.readyState).toBe(WebSocket.OPEN);
  });
});

// F-04 — the WebSocketServer is constructed with
// `maxPayload: MAX_EVENT_DATA_BYTES + 64 KiB` so the `ws` library rejects an
// oversized frame at the protocol layer (close code 1009) BEFORE buffering
// ~100 MiB and JSON.parsing it on the event loop. Default MAX_EVENT_DATA_BYTES
// is 65_536, so the cap here is 65_536 + 65_536 = 131_072 bytes.
describe("WebSocket per-frame payload cap (F-04)", () => {
  const MAX_PAYLOAD = 65_536 + 64 * 1024; // mirrors config default

  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  afterEach(async () => {
    await closeAll();
  });

  it("closes an oversized frame with 1009 without crashing the server, and keeps other connections alive", async () => {
    const apiKey = await seedAgent();
    // This file pins MAX_WS_CONNECTIONS_PER_PANE=2 for the cap tests, but THIS
    // test is about the per-frame payload cap, not the connection cap. Put each
    // socket on its OWN pane so we never approach the per-pane cap and never
    // race the asynchronous slot drain when the abusive socket is force-closed
    // (that race produced a flaky cap-429 on slow CI). Distinct panes keep this
    // test purely about payload behavior.
    const a = await createPane(apiKey);
    const b = await createPane(apiKey);
    const c = await createPane(apiKey);

    // An independent connection (own pane) that must survive the abusive one
    // being killed — proves the process/event loop stayed healthy.
    const bystander = await open(b.paneId, b.agentToken);
    expect(bystander.readyState).toBe(WebSocket.OPEN);

    const abusive = await open(a.paneId, a.agentToken);

    // Frame comfortably larger than maxPayload. `ws` rejects it at the
    // protocol layer; the client sees a close with code 1009 (message too big).
    const closeInfo = await new Promise<{ code: number }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("oversized frame neither closed nor errored")),
        4000,
      );
      abusive.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
      // A valid-JSON envelope padded past the cap so the only thing wrong is
      // its size. We never expect the relay to parse it.
      const huge = JSON.stringify({
        type: "ping",
        data: { pad: "a".repeat(MAX_PAYLOAD + 1024) },
      });
      abusive.send(huge);
    });

    // ws uses 1009 (message too big) when a frame exceeds maxPayload.
    expect(closeInfo.code).toBe(1009);

    // The server is still up and the bystander socket is unaffected: a normal
    // round-trip still works.
    expect(bystander.readyState).toBe(WebSocket.OPEN);
    const ack = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no response to normal frame after oversized")),
        4000,
      );
      bystander.once("message", (raw: Buffer) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString()));
      });
      bystander.send(JSON.stringify({ type: "ping", data: {} }));
    });
    // We don't assert the exact ack shape (covered elsewhere) — only that the
    // server responded, proving it survived the oversized frame.
    expect(ack).toBeTruthy();

    // A brand-new connection (its own fresh pane) can still be established
    // after the abuse — the server stayed up and accepts new upgrades.
    const after = await open(c.paneId, c.agentToken);
    expect(after.readyState).toBe(WebSocket.OPEN);
  });

  it("accepts a normal-sized frame just under the cap", async () => {
    const apiKey = await seedAgent();
    const { paneId, agentToken } = await createPane(apiKey);
    const ws = await open(paneId, agentToken);

    // A frame whose total size is comfortably under maxPayload still rides the
    // protocol layer and reaches the app handler (which acks it).
    const ack = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no ack for normal-sized frame")),
        4000,
      );
      ws.once("message", (raw: Buffer) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString()));
      });
      ws.send(JSON.stringify({ type: "ping", data: {} }));
    });
    expect(ack).toBeTruthy();
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

// Retry `open(...)` until it succeeds, swallowing only the "cap not yet
// drained" 429. Any other failure (different status, connection refused,
// wrong token) propagates immediately. Bounded by `deadlineMs` so a real
// deadlock still panes as a test failure within a sane budget.
async function openWhenSlotFree(
  paneId: string,
  token: string,
  deadlineMs: number,
): Promise<WebSocket> {
  const giveUpAt = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await open(paneId, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/upgrade rejected: 429/.test(msg) || Date.now() >= giveUpAt) {
        throw err;
      }
      // 25ms is short enough that the typical drain (<150ms) doesn't add
      // noticeable test latency, but long enough to avoid hammering the
      // server in a tight loop.
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
