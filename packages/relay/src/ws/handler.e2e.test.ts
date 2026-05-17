// End-to-end test for the WebSocket transport. Boots the real HTTP server
// with attachWs(), connects with the `ws` client, exercises:
//   - auth (good token, missing token, wrong session)
//   - replay on connect
//   - frame -> ack happy path
//   - schema-violating frame -> error frame (no ack)
//   - idempotency dedupe on the WS path
//   - participant.joined / participant.left system events
// DB engine follows DATABASE_URL (sqlite or postgres) — CI matrix runs both.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);

  const config = loadConfig();
  // The shared general limiter the relay hands to both buildApp() and
  // attachWs(), so HTTP and WS-upgrade attempts bucket against one per-IP map.
  const generalLimiter = createRateLimiter(
    config.RATE_LIMIT,
    config.RATE_LIMIT_WINDOW_SECONDS * 1000,
  );
  app = buildApp(config, prisma, generalLimiter);

  // Adapt Hono's fetch handler to a node:http server. Simpler than @hono/node-server
  // for tests because we control listen()/close() directly.
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  await testDb.cleanup();
});

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

const minimalSchema = {
  events: {
    "review.commentAdded": {
      payload: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
      emittedBy: ["page", "agent"],
    },
  },
};

async function createSession(apiKey: string): Promise<{
  sessionId: string;
  agentToken: string;
  humanToken: string;
}> {
  const res = await fetch(`http://localhost:${port}/v1/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      artifact: { type: "html-inline", source: "<html></html>" },
      schema: minimalSchema,
      participants: { humans: 1 },
    }),
  });
  const body = (await res.json()) as {
    session_id: string;
    tokens: { humans: string[]; agent: string };
  };
  return {
    sessionId: body.session_id,
    agentToken: body.tokens.agent,
    humanToken: body.tokens.humans[0]!,
  };
}

function connect(sessionId: string, token: string): WebSocket {
  return new WebSocket(
    `ws://localhost:${port}/v1/sessions/${sessionId}/stream?token=${token}`,
  );
}

// FrameQueue buffers every received message into a queue and exposes async
// `next()` / `take(n)`. Avoids the listener-races in ad-hoc once/on patterns.
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
  next(timeoutMs = 1500): Promise<unknown> {
    if (this.buf.length > 0) return Promise.resolve(this.buf.shift()!);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
      this.waiters.push((v) => {
        clearTimeout(t);
        resolve(v);
      });
    });
  }
  async take(n: number, timeoutMs = 1500): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(await this.next(timeoutMs));
    return out;
  }
}

function waitOpen(ws: WebSocket, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(t);
      reject(new Error(`unexpected-response ${res.statusCode}`));
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

describe("WS e2e", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects upgrade with no token (401)", async () => {
    const { apiKey } = await seedAgent();
    const { sessionId } = await createSession(apiKey);
    const ws = new WebSocket(
      `ws://localhost:${port}/v1/sessions/${sessionId}/stream`,
    );
    await expect(waitOpen(ws)).rejects.toThrow(/401/);
  });

  it("rejects participant token used against a different session (404)", async () => {
    const { apiKey } = await seedAgent();
    const a = await createSession(apiKey);
    const b = await createSession(apiKey);
    const ws = connect(a.sessionId, b.humanToken);
    await expect(waitOpen(ws)).rejects.toThrow(/404/);
  });

  it("agent connects, sends a frame, receives an ack", async () => {
    const { apiKey } = await seedAgent();
    const { sessionId, agentToken } = await createSession(apiKey);
    const ws = connect(sessionId, agentToken);
    const q = new FrameQueue(ws);
    await waitOpen(ws);

    // First two frames are the self-join broadcast + replay.complete.
    const initial = await q.take(2);
    expect(
      initial.some(
        (f) => (f as { type?: string }).type === "system.participant.joined",
      ),
    ).toBe(true);
    expect(
      initial.some(
        (f) => (f as { kind?: string }).kind === "system.replay.complete",
      ),
    ).toBe(true);

    ws.send(
      JSON.stringify({ type: "review.commentAdded", data: { body: "hello" } }),
    );
    // The server publishes the broadcast first (the sender sees its own event
    // echoed), then sends the ack. Read both and assert each separately.
    const echo = (await q.next()) as { type?: string; data?: { body: string } };
    expect(echo.type).toBe("review.commentAdded");
    expect(echo.data?.body).toBe("hello");
    const ack = (await q.next()) as { ack?: string; deduped?: boolean };
    expect(typeof ack.ack).toBe("string");
    expect(ack.deduped).toBe(false);

    const rows = await prisma.event.findMany({
      where: { sessionId, type: "review.commentAdded" },
    });
    expect(rows).toHaveLength(1);
    ws.close();
  });

  it("schema violation produces an error frame, no ack, no row", async () => {
    const { apiKey } = await seedAgent();
    const { sessionId, agentToken } = await createSession(apiKey);
    const ws = connect(sessionId, agentToken);
    const q = new FrameQueue(ws);
    await waitOpen(ws);
    await q.take(2); // burn join + replay.complete

    ws.send(
      JSON.stringify({ type: "review.commentAdded", data: { wrongField: 1 } }),
    );
    const frame = (await q.next()) as {
      error?: {
        code: string;
        hint?: string;
        retryable?: boolean;
        docs_url?: string;
      };
    };
    expect(frame.error?.code).toBe("schema_violation");
    // The WS error frame carries the same agent-friendly fields as HTTP.
    expect(frame.error?.retryable).toBe(false);
    expect(frame.error?.hint).toBeTruthy();
    expect(frame.error?.docs_url).toContain("docs/SPEC.md#");

    const rows = await prisma.event.findMany({
      where: { sessionId, type: "review.commentAdded" },
    });
    expect(rows).toHaveLength(0);
    ws.close();
  });

  it("idempotency_key replay on WS returns deduped: true", async () => {
    const { apiKey } = await seedAgent();
    const { sessionId, agentToken } = await createSession(apiKey);
    const ws = connect(sessionId, agentToken);
    const q = new FrameQueue(ws);
    await waitOpen(ws);
    await q.take(2);

    const key = "ws-idem-" + randomBytes(6).toString("hex");
    // First send: broadcast echo, then ack.
    ws.send(
      JSON.stringify({
        type: "review.commentAdded",
        data: { body: "x" },
        idempotency_key: key,
      }),
    );
    await q.next(); // echo
    const a = (await q.next()) as { ack?: string; deduped?: boolean };
    // Second send: dedupe path skips publish, so ONLY the ack arrives.
    ws.send(
      JSON.stringify({
        type: "review.commentAdded",
        data: { body: "x" },
        idempotency_key: key,
      }),
    );
    const b = (await q.next()) as { ack?: string; deduped?: boolean };

    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.ack).toBe(a.ack);

    const rows = await prisma.event.findMany({
      where: { sessionId, idempotencyKey: key },
    });
    expect(rows).toHaveLength(1);
    ws.close();
  });

  it("replays past events to a late-connecting subscriber", async () => {
    const { apiKey } = await seedAgent();
    const { sessionId, agentToken } = await createSession(apiKey);

    for (const body of ["one", "two"]) {
      await fetch(`http://localhost:${port}/v1/sessions/${sessionId}/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "review.commentAdded", data: { body } }),
      });
    }

    const ws = connect(sessionId, agentToken);
    const q = new FrameQueue(ws);
    await waitOpen(ws);
    const frames = await q.take(4); // joined + 2 replayed + replay.complete
    const replayed = frames.filter(
      (f) => (f as { type?: string }).type === "review.commentAdded",
    ) as { data: { body: string } }[];
    expect(replayed.map((f) => f.data.body)).toEqual(["one", "two"]);
    expect(
      frames.some(
        (f) => (f as { kind?: string }).kind === "system.replay.complete",
      ),
    ).toBe(true);
    ws.close();
  });
});
