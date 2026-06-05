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
import {
  isEvent,
  isRecordDelta,
  isTemplateRecordDelta,
  subscribe,
  subscribeToTemplate,
} from "../http/broadcast.js";
import {
  SYSTEM_REPLAY_COMPLETE,
  recordDelete,
  recordReplayComplete,
  recordUpsert,
  templateRecordDelete,
  templateRecordReplayComplete,
  templateRecordUpsert,
} from "./messages.js";
import { serializeRecord } from "../core/records.js";
import { serializeTemplateRecord } from "../core/template-records.js";
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
import type { PaneWithTemplateVersion } from "../core/events.js";

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

const STREAM_RX = /^\/v1\/panes\/([^/]+)\/stream(\?.*)?$/;

// #295 — cap on rows replayed per collection per connect. Above this, a
// client sees the first N and then catches up via the GET pagination route
// using the last seq it received as `?since=`. Generous enough for typical
// reconnect cases (a few hundred new comments since last seen) without
// streaming a 50k-row collection over WS in one shot.
const MAX_RECORDS_REPLAY_BATCH = 1_000;

// #295 — parsed record-replay subscription for a connection. Empty
// `collections` = no record traffic on this connection (the default if
// `?subscribe_records` is absent).
interface RecordSubscriptions {
  collections: string[];
  sinceByCollection: Map<string, number>;
}

class RecordSubscriptionError extends Error {}

// Exposed for unit testing — see ws/parse-record-subscriptions.test.ts.
export const __recordSubsInternals = {
  RecordSubscriptionError,
  parse: (url: URL, pane: PaneWithTemplateVersion) =>
    parseRecordSubscriptions(url, pane),
};

// Parse `?subscribe_records=` + `?since_record_seq.<name>=` from the WS
// upgrade URL. Throws RecordSubscriptionError on a malformed param so the
// caller can reject the upgrade with 400 — better to fail loudly than
// silently miss messages because of a typo.
// Parses `?subscribe_template_records=*|name,name` + per-collection cursors.
// Returns null when the param is absent. Validation mirrors
// parseRecordSubscriptions but reads from templateRecordSchema instead of
// recordSchema.
function parseTemplateRecordSubscriptions(
  url: URL,
  pane: PaneWithTemplateVersion,
): RecordSubscriptions | null {
  const raw = url.searchParams.get("subscribe_template_records");
  if (raw === null) return null;

  const tplSchema = (
    pane.templateVersion as unknown as { templateRecordSchema: unknown }
  ).templateRecordSchema as Record<string, unknown> | null;
  const xpc =
    tplSchema && typeof tplSchema === "object"
      ? ((tplSchema["x-pane-collections"] as Record<string, unknown>) ?? null)
      : null;
  const declared = xpc ? Object.keys(xpc) : [];

  let collections: string[];
  if (raw === "*") {
    collections = declared;
  } else {
    collections = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const name of collections) {
      if (!declared.includes(name)) {
        throw new RecordSubscriptionError(
          `subscribe_template_records: collection '${name}' is not declared in this pane's template template_record_schema (declared: ${declared.join(", ") || "none"})`,
        );
      }
    }
  }

  const sinceByCollection = new Map<string, number>();
  for (const [k, v] of url.searchParams.entries()) {
    const m = /^since_template_record_seq\.(.+)$/.exec(k);
    if (!m) continue;
    const name = m[1]!;
    if (!collections.includes(name)) {
      throw new RecordSubscriptionError(
        `since_template_record_seq.${name}: collection is not in subscribe_template_records`,
      );
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      throw new RecordSubscriptionError(
        `since_template_record_seq.${name} must be a non-negative integer`,
      );
    }
    sinceByCollection.set(name, n);
  }

  return { collections, sinceByCollection };
}

function parseRecordSubscriptions(
  url: URL,
  pane: PaneWithTemplateVersion,
): RecordSubscriptions | null {
  const raw = url.searchParams.get("subscribe_records");
  if (raw === null) return null;

  // Declared collections from the pane's pinned templateVersion.
  const recordSchema = (
    pane.templateVersion as unknown as { recordSchema: unknown }
  ).recordSchema as Record<string, unknown> | null;
  const xpc =
    recordSchema && typeof recordSchema === "object"
      ? ((recordSchema["x-pane-collections"] as Record<string, unknown>) ??
        null)
      : null;
  const declared = xpc ? Object.keys(xpc) : [];

  let collections: string[];
  if (raw === "*") {
    collections = declared;
  } else {
    collections = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const name of collections) {
      if (!declared.includes(name)) {
        throw new RecordSubscriptionError(
          `subscribe_records: collection '${name}' is not declared in this pane's template recordSchema (declared: ${declared.join(", ") || "none"})`,
        );
      }
    }
  }

  const sinceByCollection = new Map<string, number>();
  for (const [k, v] of url.searchParams.entries()) {
    const m = /^since_record_seq\.(.+)$/.exec(k);
    if (!m) continue;
    const name = m[1]!;
    if (!collections.includes(name)) {
      throw new RecordSubscriptionError(
        `since_record_seq.${name}: collection is not in subscribe_records`,
      );
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      throw new RecordSubscriptionError(
        `since_record_seq.${name} must be a non-negative integer`,
      );
    }
    sinceByCollection.set(name, n);
  }

  return { collections, sinceByCollection };
}

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

// `ws` does not pane "did this socket pong recently" — we track it ourselves
// on the socket object via this property. We also stash the socket's paneId
// so the heartbeat can refresh that pane's Redis presence-hash TTL (the
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
  // Cap the per-frame buffer at the protocol layer. The `ws` default is
  // 100 MiB, which lets an authenticated client repeatedly force a 100 MiB
  // allocation + a synchronous JSON.parse on the single event loop (the
  // message handler parses the full frame BEFORE the app-level
  // MAX_EVENT_DATA_BYTES check). Size this just above the largest legitimate
  // frame: MAX_EVENT_DATA_BYTES of `data` plus the same 64 KiB envelope
  // headroom the HTTP event routes use (see http/app.ts bodyLimit). Oversized
  // frames are rejected by `ws` with close code 1009 before any buffering, and
  // the per-socket 'error' handler in handleConnection keeps the process alive.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: deps.config.MAX_EVENT_DATA_BYTES + 64 * 1024,
  });
  server.on("upgrade", (req, socket, head) => {
    void handleUpgrade(wss, deps, req, socket, head);
  });

  // Server-side ping/pong heartbeat. Every tick: terminate any socket that
  // missed the previous ping's pong, then ping the rest. Browsers answer a
  // protocol-level ping automatically (no app code needed), so this both keeps
  // browser connections warm and detects dead peers.
  const heartbeat = setInterval(() => {
    // Sessions with at least one live socket on this replica — their Redis
    // presence-hash TTL gets refreshed below so an active pane never
    // expires while a dead replica's panes are left to lapse.
    const liveSessions = new Set<string>();
    for (const client of wss.clients) {
      const ws = client as AliveWs;
      if (ws.isAlive === false) {
        log.debug("ws heartbeat: terminating unresponsive socket", {
          paneId: ws.paneSessionId,
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
    // Refresh presence TTLs for every still-live pane. No-op when Redis is
    // off (the in-process Map has no TTL).
    for (const paneId of liveSessions) {
      void refreshSession(paneId);
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
    const paneId = m[1]!;

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
          paneId,
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
      sendUpgradeError(socket, 429, "rate limit exceeded", { paneId });
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
      sendUpgradeError(socket, 401, "missing credential", { paneId });
      return;
    }

    let author: Author;
    let pane: PaneWithTemplateVersion;
    let participant: Participant | null = null;

    if (cred.kind === "ticket") {
      // The ticket replaces the AUTHENTICATION step only: redeeming it yields
      // the bound Author directly (no resolveBearer DB call). The handler
      // still needs the Pane row (open/expiry check, passed downstream)
      // and, for a participant, the participant row for the joinedAt update —
      // so we load those below exactly as the token path does.
      const redeemed = redeemTicket(cred.value, paneId);
      if (!redeemed) {
        sendUpgradeError(socket, 401, "ticket invalid or expired", {
          paneId,
        });
        return;
      }
      author = redeemed;
      const s = await prisma.pane.findUnique({
        where: { id: paneId },
        include: { templateVersion: true },
      });
      if (!s) {
        sendUpgradeError(socket, 404, "pane not found (ticket path)", {
          paneId,
        });
        return;
      }
      pane = s;
      if (author.kind !== "agent" || author.id !== s.agentId) {
        // A non-agent author, or an agent author that is not the pane
        // owner, is a participant — load its row for the joinedAt update.
        participant = await prisma.participant.findFirst({
          where: { paneId, identityId: author.id },
        });
      }
    } else {
      // F-02: thread the upgrade request's Cookie header into resolveBearer so
      // an identity-bound participant token only resolves with the matching
      // `pane_login` cookie. The browser sends cookies on the WS handshake
      // (same-origin upgrade); a leaked token used from a context without the
      // cookie collapses to "not resolvable" and is rejected below.
      const cookieHeader =
        typeof req.headers["cookie"] === "string"
          ? req.headers["cookie"]
          : null;
      const resolved = await resolveBearer(
        prisma,
        cred.value,
        "both",
        cookieHeader,
      );
      if (!resolved) {
        sendUpgradeError(socket, 404, "bearer not resolvable", { paneId });
        return;
      }
      if (resolved.kind === "participant") {
        if (resolved.participant.paneId !== paneId) {
          sendUpgradeError(socket, 404, "participant pane mismatch", {
            paneId,
          });
          return;
        }
        participant = resolved.participant;
        pane = resolved.pane;
        author = {
          kind: participant.kind === "agent" ? "agent" : "human",
          id: participant.identityId,
        };
      } else {
        const s = await prisma.pane.findUnique({
          where: { id: paneId },
          include: { templateVersion: true },
        });
        if (!s || s.agentId !== resolved.agent.id) {
          sendUpgradeError(socket, 404, "agent not pane owner", {
            paneId,
          });
          return;
        }
        pane = s;
        author = { kind: "agent", id: resolved.agent.id };
      }
    }

    // F-08 — a soft-deleted (trashed) pane keeps status="open" + a future
    // expiresAt until the hard-delete sweeper runs, so the status/expiry gate
    // below does NOT catch it. Refuse the WS upgrade so a trashed pane can't
    // be read (event/record replay) or written (frame writes) over the
    // socket. Mirrors the dualAuth HTTP refusal (auth.ts) and the writeEvent
    // refusal (core/events.ts). 410 matches errors.softDeleted's status.
    if (pane.deletedAt !== null) {
      sendUpgradeError(socket, 410, "pane is in trash", {
        paneId,
        paneStatus: pane.status,
      });
      return;
    }

    if (pane.status !== "open" || pane.expiresAt.getTime() < Date.now()) {
      sendUpgradeError(socket, 410, "pane closed or expired", {
        paneId,
        paneStatus: pane.status,
      });
      return;
    }

    // Per-pane WebSocket connection cap. Bounds how many concurrent sockets
    // a single pane/token can hold open, so an abusive client cannot
    // exhaust file descriptors / memory by opening connections in a loop.
    if (
      config.MAX_WS_CONNECTIONS_PER_PANE > 0 &&
      (await connectionCount(paneId)) >= config.MAX_WS_CONNECTIONS_PER_PANE
    ) {
      sendUpgradeError(socket, 429, "connection cap reached", { paneId });
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

    // #295 — record-replay subscription params:
    //   ?subscribe_records=*          → subscribe to all declared collections
    //   ?subscribe_records=a,b        → subscribe to those two
    //   ?since_record_seq.<name>=N    → per-collection replay cursor
    let recordSubscriptions: RecordSubscriptions | null = null;
    let templateRecordSubscriptions: RecordSubscriptions | null = null;
    try {
      recordSubscriptions = parseRecordSubscriptions(url, pane);
      templateRecordSubscriptions = parseTemplateRecordSubscriptions(url, pane);
    } catch (err) {
      if (err instanceof RecordSubscriptionError) {
        sendUpgradeError(socket, 400, err.message, { paneId });
        return;
      }
      throw err;
    }

    // Capture in lexical scope so handleConnection (closure-free) can use it.
    const localSubs = recordSubscriptions;
    const localTplSubs = templateRecordSubscriptions;
    const templateId = pane.templateVersion.templateId;
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConnection(
        ws,
        deps,
        paneId,
        author,
        since,
        localSubs,
        localTplSubs,
        templateId,
      );
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
// `context` carries the paneId (and anything else useful) — both are
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
  paneId: string,
): Promise<SerializedEvent> {
  const data =
    e.data && typeof e.data === "object" ? { ...(e.data as object) } : {};
  return {
    ...e,
    data: { ...data, agentCountLive: await agentCount(paneId) },
  };
}

async function handleConnection(
  ws: WebSocket,
  deps: WsDeps,
  paneId: string,
  author: Author,
  sinceCursor: number | null,
  recordSubs: RecordSubscriptions | null,
  templateRecordSubs: RecordSubscriptions | null,
  templateId: string,
): Promise<void> {
  const { prisma } = deps;
  const openedAt = Date.now();
  // Heartbeat bookkeeping: a fresh socket starts alive, and every pong the peer
  // sends (browsers answer the server ping automatically) re-arms it. The
  // heartbeat interval in attachWs() flips this to false on each ping and
  // terminates the socket if it's still false on the next tick.
  const alive = ws as AliveWs;
  alive.isAlive = true;
  // Stash the paneId so the heartbeat can refresh this pane's Redis
  // presence-hash TTL (ghost cleanup — see ws/presence.ts).
  alive.paneSessionId = paneId;
  ws.on("pong", () => {
    alive.isAlive = true;
  });

  log.info("ws connected", {
    paneId,
    authorKind: author.kind,
    authorId: author.id,
  });

  ws.on("error", (err: Error) => {
    log.warn("ws error", {
      paneId,
      authorKind: author.kind,
      error: err.message,
    });
  });

  // Register this socket in the live presence registry BEFORE we compute the
  // joined event's agentCountLive, so the count reflects this connection too.
  const connId = randomUUID();
  await addConnection(
    paneId,
    connId,
    author.kind === "agent" ? "agent" : "human",
  );

  // 1) Append + broadcast a participant.joined system event so other peers see us.
  //    The persisted row is exactly as before; `withLiveCount` decorates only
  //    the broadcast copy with the live agent count.
  await appendSystemEvent(
    prisma,
    paneId,
    "system.participant.joined",
    { author: { kind: author.kind, id: author.id } },
    (e) => withLiveCount(e, paneId),
  );

  // 2) Replay every event since `sinceCursor` (or from the start).
  const replayWhere: { paneId: string; id?: { gt: number } } = { paneId };
  if (sinceCursor !== null) replayWhere.id = { gt: sinceCursor };
  const replay = await prisma.event.findMany({
    where: replayWhere,
    orderBy: { id: "asc" },
  });
  for (const row of replay) {
    sendJson(ws, serializeEvent(row));
  }
  sendJson(ws, SYSTEM_REPLAY_COMPLETE);

  // 2b) #295 — record replay. For each subscribed collection, drain rows
  //     (including tombstones) with seq > <client's since_record_seq for that
  //     collection>, emit them as record.upsert / record.delete messages,
  //     then emit record.replay.complete. The lastReplaySeq map drives
  //     dedup in the live subscribe callback below.
  const lastReplaySeq = new Map<string, number>();
  if (recordSubs && recordSubs.collections.length > 0) {
    for (const name of recordSubs.collections) {
      const since = recordSubs.sinceByCollection.get(name) ?? 0;
      const col = await prisma.recordCollection.findUnique({
        where: { paneId_name: { paneId, name } },
      });
      if (!col) {
        // Declared collection with no rows yet — emit only the sentinel so
        // the client knows replay is done.
        sendJson(ws, recordReplayComplete(name, since));
        lastReplaySeq.set(name, since);
        continue;
      }
      const rows = await prisma.paneRecord.findMany({
        where: { collectionId: col.id, seq: { gt: since } },
        orderBy: { seq: "asc" },
        take: MAX_RECORDS_REPLAY_BATCH,
      });
      for (const row of rows) {
        if (row.deletedAt) {
          sendJson(
            ws,
            recordDelete(name, {
              id: row.id,
              key: row.recordKey,
              seq: row.seq,
              deleted_at: row.deletedAt.toISOString(),
            }),
          );
        } else {
          sendJson(ws, recordUpsert(name, serializeRecord(row, name)));
        }
      }
      const last = rows.length > 0 ? rows[rows.length - 1]!.seq : since;
      sendJson(ws, recordReplayComplete(name, last));
      lastReplaySeq.set(name, last);
    }
  }

  // 2c) Template-record replay (template-level records). Same pattern as
  //     per-pane records but the collection lives on Template (head) rather
  //     than this pane. Drains rows from template_records via the named
  //     collection. The lastTplReplaySeq map drives dedup in the live
  //     subscribe callback below.
  const lastTplReplaySeq = new Map<string, number>();
  if (templateRecordSubs && templateRecordSubs.collections.length > 0) {
    for (const name of templateRecordSubs.collections) {
      const since = templateRecordSubs.sinceByCollection.get(name) ?? 0;
      const col = await prisma.templateRecordCollection.findUnique({
        where: { templateId_name: { templateId, name } },
      });
      if (!col) {
        sendJson(ws, templateRecordReplayComplete(name, since));
        lastTplReplaySeq.set(name, since);
        continue;
      }
      const rows = await prisma.templateRecord.findMany({
        where: { collectionId: col.id, seq: { gt: since } },
        orderBy: { seq: "asc" },
        take: MAX_RECORDS_REPLAY_BATCH,
      });
      for (const row of rows) {
        if (row.deletedAt) {
          sendJson(
            ws,
            templateRecordDelete(name, {
              id: row.id,
              key: row.recordKey,
              seq: row.seq,
              deleted_at: row.deletedAt.toISOString(),
            }),
          );
        } else {
          sendJson(
            ws,
            templateRecordUpsert(name, serializeTemplateRecord(row, name)),
          );
        }
      }
      const last = rows.length > 0 ? rows[rows.length - 1]!.seq : since;
      sendJson(ws, templateRecordReplayComplete(name, last));
      lastTplReplaySeq.set(name, last);
    }
  }

  // 3) Subscribe to live broadcast. De-dupe vs replay: events strictly newer
  //    than the last replayed id; record deltas strictly newer than the
  //    per-collection last replay seq. Record messages for collections this
  //    client didn't subscribe to are dropped.
  const lastReplayId =
    replay.length > 0 ? replay[replay.length - 1]!.id : (sinceCursor ?? 0);
  const subscribedSet = recordSubs
    ? new Set(recordSubs.collections)
    : new Set<string>();
  const tplSubscribedSet = templateRecordSubs
    ? new Set(templateRecordSubs.collections)
    : new Set<string>();
  const unsub = subscribe(paneId, (m) => {
    if (isEvent(m)) {
      const n = Number(m.id);
      if (Number.isFinite(n) && n > lastReplayId) sendJson(ws, m);
      return;
    }
    if (isRecordDelta(m)) {
      // Only record.upsert and record.delete carry actual state changes —
      // record.replay.complete is a handshake sentinel emitted by this
      // handler itself, not by the writer, so it never appears here.
      if (m.kind !== "record.upsert" && m.kind !== "record.delete") return;
      if (!subscribedSet.has(m.collection)) return;
      const lastSeq = lastReplaySeq.get(m.collection) ?? 0;
      if (m.record.seq > lastSeq) sendJson(ws, m);
      return;
    }
    // Unknown kind — ignore. Forwards-compatible with future wire shapes.
  });

  // 3b) Subscribe to the template bus. Same dedup discipline as the pane bus.
  const unsubTemplate = subscribeToTemplate(templateId, (m) => {
    if (!isTemplateRecordDelta(m)) return;
    if (
      m.kind !== "template-record.upsert" &&
      m.kind !== "template-record.delete"
    )
      return;
    if (!tplSubscribedSet.has(m.collection)) return;
    const lastSeq = lastTplReplaySeq.get(m.collection) ?? 0;
    if (m.record.seq > lastSeq) sendJson(ws, m);
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
    await handleFrame(ws, deps, paneId, author, msg);
  });

  ws.on("close", (code: number, reason: Buffer) => {
    log.info("ws closed", {
      paneId,
      authorKind: author.kind,
      authorId: author.id,
      code,
      reason: reason.toString().slice(0, MAX_CLOSE_REASON_LOG_LENGTH),
      openMs: Date.now() - openedAt,
    });
    unsub();
    unsubTemplate();
    // Deregister from the live presence registry FIRST (and await it, so the
    // participant.left event's agentCountLive reflects this socket already
    // being gone) THEN insert + broadcast the participant.left event. The
    // whole sequence is async because the presence registry is async (it is
    // Redis-backed in multi-replica mode); it is fire-and-forget from the
    // close-event callback's perspective.
    void (async () => {
      try {
        await removeConnection(paneId, connId);
        // appendSystemEvent persists + broadcasts, and tolerates the pane
        // having been deleted while this socket was draining (returns null).
        await appendSystemEvent(
          prisma,
          paneId,
          "system.participant.left",
          { author: { kind: author.kind, id: author.id } },
          (e) => withLiveCount(e, paneId),
        );
      } catch (err) {
        log.warn("participant.left event insert failed", {
          paneId,
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
  paneId: string,
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

  // Quick byte-cap check before we re-read the pane — saves a round-trip on
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

  // Re-read the pane so writeEvent sees the latest schema/status.
  // (writeEvent itself throws errors.gone() if the pane is closed/expired,
  // so we don't double-check that here.)
  const pane = await prisma.pane.findUnique({
    where: { id: paneId },
    include: { templateVersion: true },
  });
  if (!pane) {
    sendJson(ws, {
      error: serializeApiError(errors.notFound()),
      ...(cid ? { correlation_id: cid } : {}),
    });
    return;
  }

  try {
    const { event, deduped } = await writeEvent(
      { prisma, config },
      pane,
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
      paneId,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(ws, {
      error: { code: "internal" },
      ...(cid ? { correlation_id: cid } : {}),
    });
  }
}
