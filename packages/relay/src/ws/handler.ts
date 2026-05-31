import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "../config.js";
import {
  MAX_EVENT_TYPE_LENGTH,
  MAX_CORRELATION_ID_LENGTH,
  MAX_CLOSE_REASON_LOG_LENGTH,
} from "../limits.js";
import { resolveBearer } from "../http/auth.js";
import {
  checkWsUpgradeRateLimit,
  type SlidingWindowLimiter,
} from "../http/rate-limit.js";
import { randomUUID } from "node:crypto";
import { isEvent, subscribe } from "../http/broadcast.js";
import { ApiError, errors, serializeApiError } from "../http/errors.js";
import { serializeEvent } from "../http/serialize.js";
import { appendSystemEvent, writeEvent } from "../core/events.js";
import {
  addConnection,
  agentCount,
  connectionCount,
  refreshSession,
  removeConnection,
} from "./presence.js";
import { redeemTicket } from "./ticket.js";
import { log } from "../log.js";
import type { Author } from "../types.js";
import type { SerializedEvent } from "../types.js";
import type { Participant, PrismaClient } from "@prisma/client";
import type { SurfaceWithArtifactVersion } from "../core/events.js";

// Injected dependencies for the WebSocket transport. The WS upgrade path runs
// outside the Hono request lifecycle, so config + the Prisma client are passed
// to attachWs() and threaded down through the handler call chain.
//
// `generalLimiter` is the SAME instance the Hono app uses for /v1/* and /s/*
// rate limiting (built once in index.ts and passed to both buildApp() and
// attachWs()), so a client's WS-upgrade attempts and HTTP requests share one
// per-IP bucket.
export interface WsDeps {
  config: Config;
  prisma: PrismaClient;
  generalLimiter: SlidingWindowLimiter;
}

const STREAM_RX = /^\/v1\/surfaces\/([^/]+)\/stream(\?.*)?$/;

// Heartbeat interval. The relay pings every open socket on this cadence; any
// socket that has not answered a ping with a pong since the previous tick is
// considered dead and terminated. This is the ONLY thing that detects a
// half-open connection (NAT/proxy/OS silently dropped it) — without it a dead
// socket lingers forever, and on the browser side a connection killed by an
// idle-reaping intermediary just looks like a close, which the shell answers
// with an immediate reconnect, producing a connect/close churn loop. A live
// ping/pong keeps the path warm so intermediaries don't reap it, and cleanly
// reaps the genuinely-dead ones instead of leaving them as ghosts.
const HEARTBEAT_INTERVAL_MS = 30_000;

// `ws` does not surface "did this socket pong recently" — we track it ourselves
// on the socket object via this property. We also stash the socket's surfaceId
// so the heartbeat can refresh that surface's Redis presence-hash TTL (the
// ghost-cleanup mechanism — see ws/presence.ts).
interface AliveWs extends WebSocket {
  isAlive?: boolean;
  paneSessionId?: string;
}

// Server type is loose because @hono/node-server may return an http.Server,
// https.Server, or Http2Server; all expose the same `upgrade` event we need.
export function attachWs(
  server: {
    on(
      event: "upgrade",
      listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
    ): unknown;
  },
  deps: WsDeps,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    void handleUpgrade(wss, deps, req, socket, head);
  });

  // Server-side ping/pong heartbeat. Every tick: terminate any socket that
  // missed the previous ping's pong, then ping the rest. Browsers answer a
  // protocol-level ping automatically (no app code needed), so this both keeps
  // browser connections warm and detects dead peers.
  const heartbeat = setInterval(() => {
    // Sessions with at least one live socket on this replica — their Redis
    // presence-hash TTL gets refreshed below so an active surface never
    // expires while a dead replica's surfaces are left to lapse.
    const liveSessions = new Set<string>();
    for (const client of wss.clients) {
      const ws = client as AliveWs;
      if (ws.isAlive === false) {
        log.debug("ws heartbeat: terminating unresponsive socket", {
          surfaceId: ws.paneSessionId,
        });
        ws.terminate();
        continue;
      }
      if (ws.paneSessionId) liveSessions.add(ws.paneSessionId);
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* socket already closing — next tick's terminate() handles it */
      }
    }
    // Refresh presence TTLs for every still-live surface. No-op when Redis is
    // off (the in-process Map has no TTL).
    for (const surfaceId of liveSessions) {
      void refreshSession(surfaceId);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}

async function handleUpgrade(
  wss: WebSocketServer,
  deps: WsDeps,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const { prisma, config, generalLimiter } = deps;
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const m = STREAM_RX.exec(url.pathname);
    if (!m) {
      socket.destroy();
      return;
    }
    const surfaceId = m[1]!;

    // Cross-site WebSocket hijacking guard. Browsers always send an `Origin`
    // header on a WS handshake; a `?token=`/`?ticket=` in the query string is
    // not protected by the same-origin policy, so a malicious page could open
    // a stream cross-site if it ever obtains a credential. When `Origin` is
    // present it MUST match the relay's own public origin. Non-browser clients
    // (agents, the CLI) omit `Origin` entirely — those are allowed through.
    const origin = req.headers["origin"];
    if (typeof origin === "string" && origin.length > 0) {
      let originOk = false;
      try {
        originOk = new URL(origin).origin === new URL(config.publicUrl).origin;
      } catch {
        originOk = false;
      }
      if (!originOk) {
        sendUpgradeError(socket, 403, "origin mismatch", {
          surfaceId,
          origin,
        });
        return;
      }
    }

    // Per-IP rate limit FIRST — before any token resolve or DB lookup — so a
    // flood of upgrade attempts cannot drive DB work. The Hono `generalRateLimit`
    // middleware does not cover the upgrade (it is handled off the Hono app).
    // Uses the injected shared limiter + TRUSTED_PROXY config. The check is
    // async because the limiter may be Redis-backed in multi-replica mode.
    if (
      !(await checkWsUpgradeRateLimit(
        req,
        generalLimiter,
        config.TRUSTED_PROXY,
      ))
    ) {
      sendUpgradeError(socket, 429, "rate limit exceeded", { surfaceId });
      return;
    }

    // Authentication accepts EITHER a short-lived ticket (preferred, the
    // browser path — see src/ws/ticket.ts and issue #8) OR the real bearer
    // token via `?token=`/`Authorization` (the existing agent/CLI path, kept
    // for backward compatibility — an agent's own infra has no proxy-log
    // concern). Precedence: a `?ticket=` present wins; otherwise fall back to
    // the token path. Either way `extractCredential` strips the value from
    // req.url so the relay's own access logs stay redacted.
    const cred = extractCredential(req, url);
    if (!cred) {
      sendUpgradeError(socket, 401, "missing credential", { surfaceId });
      return;
    }

    let author: Author;
    let surface: SurfaceWithArtifactVersion;
    let participant: Participant | null = null;

    if (cred.kind === "ticket") {
      // The ticket replaces the AUTHENTICATION step only: redeeming it yields
      // the bound Author directly (no resolveBearer DB call). The handler
      // still needs the Surface row (open/expiry check, passed downstream)
      // and, for a participant, the participant row for the joinedAt update —
      // so we load those below exactly as the token path does.
      const redeemed = redeemTicket(cred.value, surfaceId);
      if (!redeemed) {
        sendUpgradeError(socket, 401, "ticket invalid or expired", {
          surfaceId,
        });
        return;
      }
      author = redeemed;
      const s = await prisma.surface.findUnique({
        where: { id: surfaceId },
        include: { templateVersion: true },
      });
      if (!s) {
        sendUpgradeError(socket, 404, "surface not found (ticket path)", {
          surfaceId,
        });
        return;
      }
      surface = s;
      if (author.kind !== "agent" || author.id !== s.agentId) {
        // A non-agent author, or an agent author that is not the surface
        // owner, is a participant — load its row for the joinedAt update.
        participant = await prisma.participant.findFirst({
          where: { surfaceId, identityId: author.id },
        });
      }
    } else {
      const resolved = await resolveBearer(prisma, cred.value);
      if (!resolved) {
        sendUpgradeError(socket, 404, "bearer not resolvable", { surfaceId });
        return;
      }
      if (resolved.kind === "participant") {
        if (resolved.participant.surfaceId !== surfaceId) {
          sendUpgradeError(socket, 404, "participant surface mismatch", {
            surfaceId,
          });
          return;
        }
        participant = resolved.participant;
        surface = resolved.surface;
        author = {
          kind: participant.kind === "agent" ? "agent" : "human",
          id: participant.identityId,
        };
      } else {
        const s = await prisma.surface.findUnique({
          where: { id: surfaceId },
          include: { templateVersion: true },
        });
        if (!s || s.agentId !== resolved.agent.id) {
          sendUpgradeError(socket, 404, "agent not surface owner", {
            surfaceId,
          });
          return;
        }
        surface = s;
        author = { kind: "agent", id: resolved.agent.id };
      }
    }

    if (surface.status !== "open" || surface.expiresAt.getTime() < Date.now()) {
      sendUpgradeError(socket, 410, "surface closed or expired", {
        surfaceId,
        surfaceStatus: surface.status,
      });
      return;
    }

    // Per-surface WebSocket connection cap. Bounds how many concurrent sockets
    // a single surface/token can hold open, so an abusive client cannot
    // exhaust file descriptors / memory by opening connections in a loop.
    if (
      config.MAX_WS_CONNECTIONS_PER_SESSION > 0 &&
      (await connectionCount(surfaceId)) >=
        config.MAX_WS_CONNECTIONS_PER_SESSION
    ) {
      sendUpgradeError(socket, 429, "connection cap reached", { surfaceId });
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
      void handleConnection(ws, deps, surfaceId, author, since);
    });
  } catch (err) {
    log.error("ws upgrade failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      socket.destroy();
    } catch {
      /* noop */
    }
  }
}

// A WS-upgrade credential: either a short-lived ticket (`?ticket=`) or the
// real bearer token (`?token=` / `Authorization`).
type UpgradeCredential =
  | { kind: "ticket"; value: string }
  | { kind: "token"; value: string };

function extractCredential(
  req: IncomingMessage,
  url: URL,
): UpgradeCredential | null {
  // A `?ticket=` always wins: the browser path mints a ticket precisely so the
  // real token never touches the URL. Strip it from req.url so any downstream
  // access log (Node http, reverse-proxy header forwarding, error traces) sees
  // a redacted URL.
  const ticket = url.searchParams.get("ticket");
  if (ticket) {
    url.searchParams.set("ticket", "***");
    req.url = url.pathname + url.search;
    return { kind: "ticket", value: ticket };
  }
  // Fallback — the real token. `?token=` is the only viable BROWSER path when
  // no ticket is used, but it is still supported here for non-browser clients
  // (the agent CLI), whose own infra has no proxy-log concern. Redact it from
  // req.url all the same — we keep the value in memory only.
  const q = url.searchParams.get("token");
  if (q) {
    url.searchParams.set("token", "***");
    req.url = url.pathname + url.search;
    return { kind: "token", value: q };
  }
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return { kind: "token", value: m[1]!.trim() };
  }
  return null;
}

// Log the rejection at info level (warn would page on noisy probe traffic;
// info still hits the aggregator) and emit the matching HTTP status line so
// the WS client sees the same status code that any HTTP caller would. `reason`
// is a short human-readable tag for operators chasing auth/cap/expiry events;
// `context` carries the surfaceId (and anything else useful) — both are
// internal-only and never leave the log line.
function sendUpgradeError(
  socket: Duplex,
  status: number,
  reason: string,
  context?: Record<string, unknown>,
): void {
  log.info("ws upgrade rejected", { status, reason, ...context });
  const statusText: Record<number, string> = {
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    410: "Gone",
    429: "Too Many Requests",
  };
  const text = statusText[status] ?? "Bad Request";
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

// Decorate a participant.joined/left event with the CURRENT live agent socket
// count before broadcasting. The persisted Event row is left untouched — this
// `agentCountLive` only rides the in-memory broadcast so shells that receive it
// AFTER `system.replay.complete` learn the exact present-tense agent count.
// Replayed (historical) rows never carry it, so the shell knows not to trust
// it for events seen during replay.
async function withLiveCount(
  e: SerializedEvent,
  surfaceId: string,
): Promise<SerializedEvent> {
  const data =
    e.data && typeof e.data === "object" ? { ...(e.data as object) } : {};
  return {
    ...e,
    data: { ...data, agentCountLive: await agentCount(surfaceId) },
  };
}

async function handleConnection(
  ws: WebSocket,
  deps: WsDeps,
  surfaceId: string,
  author: Author,
  sinceCursor: number | null,
): Promise<void> {
  const { prisma } = deps;
  const openedAt = Date.now();
  // Heartbeat bookkeeping: a fresh socket starts alive, and every pong the peer
  // sends (browsers answer the server ping automatically) re-arms it. The
  // heartbeat interval in attachWs() flips this to false on each ping and
  // terminates the socket if it's still false on the next tick.
  const alive = ws as AliveWs;
  alive.isAlive = true;
  // Stash the surfaceId so the heartbeat can refresh this surface's Redis
  // presence-hash TTL (ghost cleanup — see ws/presence.ts).
  alive.paneSessionId = surfaceId;
  ws.on("pong", () => {
    alive.isAlive = true;
  });

  log.info("ws connected", {
    surfaceId,
    authorKind: author.kind,
    authorId: author.id,
  });

  ws.on("error", (err: Error) => {
    log.warn("ws error", {
      surfaceId,
      authorKind: author.kind,
      error: err.message,
    });
  });

  // Register this socket in the live presence registry BEFORE we compute the
  // joined event's agentCountLive, so the count reflects this connection too.
  const connId = randomUUID();
  await addConnection(
    surfaceId,
    connId,
    author.kind === "agent" ? "agent" : "human",
  );

  // 1) Append + broadcast a participant.joined system event so other peers see us.
  //    The persisted row is exactly as before; `withLiveCount` decorates only
  //    the broadcast copy with the live agent count.
  await appendSystemEvent(
    prisma,
    surfaceId,
    "system.participant.joined",
    { author: { kind: author.kind, id: author.id } },
    (e) => withLiveCount(e, surfaceId),
  );

  // 2) Replay every event since `sinceCursor` (or from the start).
  const replayWhere: { surfaceId: string; id?: { gt: number } } = { surfaceId };
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
  const lastReplayId =
    replay.length > 0 ? replay[replay.length - 1]!.id : (sinceCursor ?? 0);
  const unsub = subscribe(surfaceId, (m) => {
    // Pre-#291 behaviour: this handler forwards events only. Record-delta
    // messages (kind: "record.*") now share the same broadcast channel
    // (#291); filter them here. Forwarding records to WS clients lands in
    // #295 (handleConnection record replay + dedup).
    if (!isEvent(m)) return;
    const n = Number(m.id);
    if (Number.isFinite(n) && n > lastReplayId) sendJson(ws, m);
  });

  ws.on("message", async (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, {
        error: serializeApiError(errors.invalidRequest("invalid JSON")),
      });
      return;
    }
    await handleFrame(ws, deps, surfaceId, author, msg);
  });

  ws.on("close", (code: number, reason: Buffer) => {
    log.info("ws closed", {
      surfaceId,
      authorKind: author.kind,
      authorId: author.id,
      code,
      reason: reason.toString().slice(0, MAX_CLOSE_REASON_LOG_LENGTH),
      openMs: Date.now() - openedAt,
    });
    unsub();
    // Deregister from the live presence registry FIRST (and await it, so the
    // participant.left event's agentCountLive reflects this socket already
    // being gone) THEN insert + broadcast the participant.left event. The
    // whole sequence is async because the presence registry is async (it is
    // Redis-backed in multi-replica mode); it is fire-and-forget from the
    // close-event callback's perspective.
    void (async () => {
      try {
        await removeConnection(surfaceId, connId);
        // appendSystemEvent persists + broadcasts, and tolerates the surface
        // having been deleted while this socket was draining (returns null).
        await appendSystemEvent(
          prisma,
          surfaceId,
          "system.participant.left",
          { author: { kind: author.kind, id: author.id } },
          (e) => withLiveCount(e, surfaceId),
        );
      } catch (err) {
        log.warn("participant.left event insert failed", {
          surfaceId,
          error: String(err),
        });
      }
    })();
  });
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (e) {
    log.warn("ws send failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function handleFrame(
  ws: WebSocket,
  deps: WsDeps,
  surfaceId: string,
  author: Author,
  msg: unknown,
): Promise<void> {
  const { config, prisma } = deps;
  if (!msg || typeof msg !== "object") {
    sendJson(ws, {
      error: serializeApiError(
        errors.invalidRequest("frame must be an object"),
      ),
    });
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
  // CLI / non-runtime WS client could send a 10MB string that we'd otherwise
  // echo back in every ack/error response. The shell runtime already caps
  // before forwarding (see bridge/routes.ts validCid); this is the
  // defence-in-depth layer for direct WS callers.
  const cid =
    typeof f.correlation_id === "string" &&
    f.correlation_id.length > 0 &&
    f.correlation_id.length <= MAX_CORRELATION_ID_LENGTH
      ? f.correlation_id
      : null;
  if (
    typeof f.type !== "string" ||
    f.type.length === 0 ||
    f.type.length > MAX_EVENT_TYPE_LENGTH
  ) {
    sendJson(ws, {
      error: serializeApiError(
        errors.invalidRequest(
          "type must be a non-empty string within 64 chars",
        ),
      ),
      ...(cid ? { correlation_id: cid } : {}),
    });
    return;
  }

  // Quick byte-cap check before we re-read the surface — saves a round-trip on
  // obviously oversize frames. writeEvent enforces the same cap authoritatively.
  if (
    Buffer.byteLength(JSON.stringify(f.data ?? null), "utf8") >
    config.MAX_EVENT_DATA_BYTES
  ) {
    sendJson(ws, {
      error: serializeApiError(errors.payloadTooLarge()),
      ...(cid ? { correlation_id: cid } : {}),
    });
    return;
  }

  // Re-read the surface so writeEvent sees the latest schema/status.
  // (writeEvent itself throws errors.gone() if the surface is closed/expired,
  // so we don't double-check that here.)
  const surface = await prisma.surface.findUnique({
    where: { id: surfaceId },
    include: { templateVersion: true },
  });
  if (!surface) {
    sendJson(ws, {
      error: serializeApiError(errors.notFound()),
      ...(cid ? { correlation_id: cid } : {}),
    });
    return;
  }

  try {
    const { event, deduped } = await writeEvent(
      { prisma, config },
      surface,
      author,
      {
        type: f.type,
        data: f.data,
        causationId: typeof f.causation_id === "string" ? f.causation_id : null,
        idempotencyKey:
          typeof f.idempotency_key === "string" ? f.idempotency_key : null,
      },
    );
    sendJson(ws, {
      ack: event.id,
      deduped,
      ...(cid ? { correlation_id: cid } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(ws, {
        error: serializeApiError(err),
        ...(cid ? { correlation_id: cid } : {}),
      });
      return;
    }
    log.error("ws writeEvent failed", {
      surfaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(ws, {
      error: { code: "internal" },
      ...(cid ? { correlation_id: cid } : {}),
    });
  }
}
