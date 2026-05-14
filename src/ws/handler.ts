import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import config from "../config.js";
import prisma from "../db.js";
import { resolveBearer } from "../http/auth.js";
import { publish, subscribe } from "../http/broadcast.js";
import { ApiError } from "../http/errors.js";
import { serializeEvent } from "../http/serialize.js";
import { writeEvent } from "../core/events.js";
import { log } from "../log.js";
import type { Author } from "../types.js";
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
  if (q) {
    // Strip the token from req.url so any downstream access log (Node http,
    // reverse-proxy header forwarding, error traces) sees a redacted URL.
    // Browsers can't set Authorization on `new WebSocket()`, so ?token= is the
    // only viable browser path — we keep the value in memory, redact from the URL.
    url.searchParams.delete("token");
    url.searchParams.set("token", "***");
    req.url = url.pathname + url.search;
    return q;
  }
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
      .catch((err: unknown) =>
        log.warn("participant.left event insert failed", {
          sessionId,
          err: String(err),
        }),
      );
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
  // Cap correlation_id at 128 chars: the protocol is publicly documented, so a
  // CLI / non-shim WS client could send a 10MB string that we'd otherwise echo
  // back in every ack/error response. The shell shim already caps before
  // forwarding (see bridge/routes.ts validCid); this is the defence-in-depth
  // layer for direct WS callers.
  const cid =
    typeof f.correlation_id === "string" && f.correlation_id.length > 0 && f.correlation_id.length <= 128
      ? f.correlation_id
      : null;
  if (typeof f.type !== "string" || f.type.length === 0 || f.type.length > 64) {
    sendJson(ws, {
      error: { code: "invalid_request", message: "type must be a non-empty string within 64 chars" },
      ...(cid ? { correlation_id: cid } : {}),
    });
    return;
  }

  // Quick byte-cap check before we re-read the session — saves a round-trip on
  // obviously oversize frames. writeEvent enforces the same cap authoritatively.
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

  // Re-read the session so writeEvent sees the latest schema/status.
  // (writeEvent itself throws errors.gone() if the session is closed/expired,
  // so we don't double-check that here.)
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) {
    sendJson(ws, { error: { code: "not_found" }, ...(cid ? { correlation_id: cid } : {}) });
    return;
  }

  try {
    const { event, deduped } = await writeEvent(session, author, {
      type: f.type,
      data: f.data,
      causationId: typeof f.causation_id === "string" ? f.causation_id : null,
      idempotencyKey: typeof f.idempotency_key === "string" ? f.idempotency_key : null,
    });
    sendJson(ws, { ack: event.id, deduped, ...(cid ? { correlation_id: cid } : {}) });
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(ws, {
        error: { code: err.code, message: err.message, details: err.details },
        ...(cid ? { correlation_id: cid } : {}),
      });
      return;
    }
    log.error("ws writeEvent failed", { sessionId, err: err instanceof Error ? err.message : String(err) });
    sendJson(ws, { error: { code: "internal" }, ...(cid ? { correlation_id: cid } : {}) });
  }
}
