import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { Prisma } from "@prisma/client";
import config from "../config.js";
import prisma from "../db.js";
import { resolveBearer } from "../http/auth.js";
import { publish, subscribe } from "../http/broadcast.js";
import { errors, ApiError } from "../http/errors.js";
import { serializeEvent } from "../http/serialize.js";
import { validateEvent } from "../http/validation.js";
import { fire, shouldFire } from "../http/webhook.js";
import { log } from "../log.js";
import type { Author, EventSchema, SerializedEvent } from "../types.js";
import type { Participant, Session } from "@prisma/client";

const STREAM_RX = /^\/v1\/sessions\/([^/]+)\/stream(\?.*)?$/;

// Server type is loose because @hono/node-server may return an http.Server,
// https.Server, or Http2Server; all expose the same `upgrade` event we need.
export function attachWs(server: { on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown }): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    void handleUpgrade(wss, req, socket, head);
  });
  return wss;
}

async function handleUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const m = STREAM_RX.exec(url.pathname);
    if (!m) {
      socket.destroy();
      return;
    }
    const sessionId = m[1]!;

    const token = extractToken(req, url);
    if (!token) {
      sendUpgradeError(socket, 401);
      return;
    }
    const resolved = await resolveBearer(token);
    if (!resolved) {
      sendUpgradeError(socket, 404);
      return;
    }

    let author: Author;
    let session: Session;
    let participant: Participant | null = null;
    if (resolved.kind === "participant") {
      if (resolved.participant.sessionId !== sessionId) {
        sendUpgradeError(socket, 404);
        return;
      }
      participant = resolved.participant;
      session = resolved.session;
      author = {
        kind: participant.kind === "agent" ? "agent" : "human",
        id: participant.identityId,
      };
    } else {
      const s = await prisma.session.findUnique({ where: { id: sessionId } });
      if (!s || s.agentId !== resolved.agent.id) {
        sendUpgradeError(socket, 404);
        return;
      }
      session = s;
      author = { kind: "agent", id: resolved.agent.id };
    }

    if (session.status !== "open" || session.expiresAt.getTime() < Date.now()) {
      sendUpgradeError(socket, 410);
      return;
    }

    if (participant && !participant.joinedAt) {
      await prisma.participant.update({
        where: { id: participant.id },
        data: { joinedAt: new Date() },
      });
    }

    const sinceRaw = url.searchParams.get("since");
    let since: number | null = null;
    if (sinceRaw) {
      const n = Number(sinceRaw);
      if (Number.isInteger(n) && n >= 0) since = n;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConnection(ws, sessionId, author, since);
    });
  } catch (err) {
    log.error("ws upgrade failed", { error: err instanceof Error ? err.message : String(err) });
    try {
      socket.destroy();
    } catch {
      /* noop */
    }
  }
}

function extractToken(req: IncomingMessage, url: URL): string | null {
  const q = url.searchParams.get("token");
  if (q) return q;
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1]!.trim();
  }
  return null;
}

function sendUpgradeError(socket: Duplex, status: number): void {
  const statusText: Record<number, string> = {
    401: "Unauthorized",
    404: "Not Found",
    410: "Gone",
  };
  const text = statusText[status] ?? "Bad Request";
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

async function handleConnection(
  ws: WebSocket,
  sessionId: string,
  author: Author,
  sinceCursor: number | null,
): Promise<void> {
  // 1) Append + broadcast a participant.joined system event so other peers see us.
  const joinEvent = await prisma.event.create({
    data: {
      sessionId,
      authorKind: "system",
      authorId: "system",
      type: "system.participant.joined",
      data: { author: { kind: author.kind, id: author.id } } as object,
    },
  });
  const joinSerialized = serializeEvent(joinEvent);
  publish(sessionId, joinSerialized);

  // 2) Replay every event since `sinceCursor` (or from the start).
  const replayWhere: { sessionId: string; id?: { gt: number } } = { sessionId };
  if (sinceCursor !== null) replayWhere.id = { gt: sinceCursor };
  const replay = await prisma.event.findMany({
    where: replayWhere,
    orderBy: { id: "asc" },
  });
  for (const row of replay) {
    sendJson(ws, serializeEvent(row));
  }
  sendJson(ws, { kind: "system.replay.complete" });

  // 3) Subscribe to live broadcast. De-dupe vs replay: only forward events
  //    strictly newer than the last replayed id.
  const lastReplayId = replay.length > 0 ? replay[replay.length - 1]!.id : sinceCursor ?? 0;
  const unsub = subscribe(sessionId, (e) => {
    const n = Number(e.id);
    if (Number.isFinite(n) && n > lastReplayId) sendJson(ws, e);
  });

  ws.on("message", async (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { error: { code: "invalid_request", message: "invalid JSON" } });
      return;
    }
    await handleFrame(ws, sessionId, author, msg);
  });

  ws.on("close", () => {
    unsub();
    void prisma.event
      .create({
        data: {
          sessionId,
          authorKind: "system",
          authorId: "system",
          type: "system.participant.left",
          data: { author: { kind: author.kind, id: author.id } } as object,
        },
      })
      .then((row) => publish(sessionId, serializeEvent(row)))
      .catch(() => {});
  });
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    log.warn("ws send failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

async function handleFrame(
  ws: WebSocket,
  sessionId: string,
  author: Author,
  msg: unknown,
): Promise<void> {
  if (!msg || typeof msg !== "object") {
    sendJson(ws, { error: { code: "invalid_request", message: "frame must be an object" } });
    return;
  }
  const f = msg as {
    type?: unknown;
    data?: unknown;
    causation_id?: unknown;
    idempotency_key?: unknown;
    correlation_id?: unknown;
  };
  const cid = typeof f.correlation_id === "string" ? f.correlation_id : null;
  if (typeof f.type !== "string" || f.type.length === 0 || f.type.length > 64) {
    sendJson(ws, {
      error: { code: "invalid_request", message: "type must be a non-empty string within 64 chars" },
      ...(cid ? { correlation_id: cid } : {}),
    });
    return;
  }
  if (
    Buffer.byteLength(JSON.stringify(f.data ?? null), "utf8") >
    config.MAX_EVENT_DATA_BYTES
  ) {
    sendJson(ws, {
      error: { code: "payload_too_large" },
      ...(cid ? { correlation_id: cid } : {}),
    });
    return;
  }

  // Re-read the session for the latest schema/status.
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) {
    sendJson(ws, { error: { code: "not_found" }, ...(cid ? { correlation_id: cid } : {}) });
    return;
  }
  if (session.status !== "open" || session.expiresAt.getTime() < Date.now()) {
    sendJson(ws, { error: { code: "gone" }, ...(cid ? { correlation_id: cid } : {}) });
    return;
  }

  try {
    validateEvent({
      sessionId,
      schemaVersion: session.schemaVersion,
      schema: session.eventSchema as unknown as EventSchema,
      type: f.type,
      data: f.data,
      authorKind: author.kind,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(ws, {
        error: { code: err.code, message: err.message, details: err.details },
        ...(cid ? { correlation_id: cid } : {}),
      });
      return;
    }
    sendJson(ws, { error: { code: "internal" }, ...(cid ? { correlation_id: cid } : {}) });
    return;
  }

  const idempotencyKey = typeof f.idempotency_key === "string" ? f.idempotency_key : null;
  const correlationId = typeof (f as { correlation_id?: unknown }).correlation_id === "string"
    ? (f as { correlation_id: string }).correlation_id
    : null;
  if (idempotencyKey) {
    const existing = await prisma.event.findUnique({
      where: {
        sessionId_authorId_idempotencyKey: {
          sessionId,
          authorId: author.id,
          idempotencyKey,
        },
      },
    });
    if (existing) {
      sendJson(ws, {
        ack: String(existing.id),
        deduped: true,
        ...(correlationId ? { correlation_id: correlationId } : {}),
      });
      return;
    }
  }

  const event = await prisma.event.create({
    data: {
      sessionId,
      authorKind: author.kind,
      authorId: author.id,
      type: f.type,
      data: (f.data ?? null) as Prisma.InputJsonValue,
      causationId: typeof f.causation_id === "string" ? f.causation_id : null,
      idempotencyKey,
    },
  });
  const serialized: SerializedEvent = serializeEvent(event);
  publish(sessionId, serialized);
  sendJson(ws, {
    ack: serialized.id,
    deduped: false,
    ...(correlationId ? { correlation_id: correlationId } : {}),
  });

  if (
    session.callbackUrl &&
    session.callbackSecretEnc &&
    shouldFire(f.type, session.callbackFilter as string[] | null)
  ) {
    fire(
      {
        url: session.callbackUrl,
        secret: session.callbackSecretEnc,
        filter: (session.callbackFilter as string[]) ?? [],
      },
      sessionId,
      serialized,
    ).catch(() => {});
  }
}
