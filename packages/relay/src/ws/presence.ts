// Real-time agent-presence registry.
//
// Tracks, per pane, the set of currently-open WebSocket connections and
// their author kind. This is LIVE runtime state — the single source of truth
// for "is an agent connected RIGHT NOW". It deliberately does NOT derive from
// the persisted `system.participant.joined`/`left` event log: a `left` event
// is written fire-and-forget and can be lost (relay restart, insert failure),
// which would leave a stale `joined` replayed forever. Connection lifecycle is
// the only reliable signal, so we track it here directly.
//
// Two backends, selected at runtime by `redisEnabled()`:
//
//   REDIS OFF (single replica / self-host) — an in-process Map of
//   paneId -> (connId -> kind). Correct and sufficient for one replica;
//   behaviour is byte-for-byte as before.
//
//   REDIS ON (multi-replica) — a Redis hash per pane, `pane:presence:<id>`,
//   field `connId` -> kind. A WebSocket is pinned to ONE replica, so without a
//   shared store replica A cannot see replica B's sockets. With the Redis
//   hash, every replica sees the cluster-wide set.
//
//     Ghost cleanup: a replica that crashes would otherwise leave its hash
//     fields counted forever. We defend with a per-pane-hash TTL that the
//     WS heartbeat refreshes (`refreshSession`): every live socket's owning
//     replica re-PEXPIREs the hash on each heartbeat tick. If a replica dies,
//     nothing refreshes its panes' hashes and Redis evicts them once the
//     TTL lapses — the cluster self-heals within one TTL window. A pane
//     that still has a live socket on some surviving replica keeps being
//     refreshed by that replica, so it never expires while genuinely active.
//     (Per-pane rather than per-connection TTL keeps it one key per
//     pane; the cost is that one dead connId can linger until the whole
//     pane hash expires — acceptable because the count is advisory and a
//     dead replica's sockets are all dead together anyway.)
//
// `addConnection`/`removeConnection`/`refreshSession` and every count function
// are ASYNC in both modes — Redis makes them inherently async, and the
// in-process path resolves immediately so callers have a single code path.

import { redisEnabled, redisPub } from "../redis.js";
import { log } from "../log.js";

type ConnKind = "agent" | "human";

// In-process backend: paneId -> (connId -> kind).
const connections = new Map<string, Map<string, ConnKind>>();

// Redis key for a pane's presence hash.
const PRESENCE_PREFIX = "pane:presence:";
function presenceKey(paneId: string): string {
  return PRESENCE_PREFIX + paneId;
}

// Per-pane presence-hash TTL. Must comfortably exceed the WS heartbeat
// interval (30s, see ws/handler.ts HEARTBEAT_INTERVAL_MS) so a live pane is
// always refreshed before it lapses, while still evicting a dead replica's
// panes reasonably promptly. 90s = 3 missed heartbeats.
const PRESENCE_TTL_MS = 90_000;

export async function addConnection(
  paneId: string,
  connId: string,
  kind: ConnKind,
): Promise<void> {
  if (!redisEnabled()) {
    let perSession = connections.get(paneId);
    if (!perSession) {
      perSession = new Map();
      connections.set(paneId, perSession);
    }
    perSession.set(connId, kind);
    return;
  }
  try {
    const key = presenceKey(paneId);
    await redisPub().hset(key, connId, kind);
    // Arm the ghost-cleanup TTL; the heartbeat refreshes it thereafter.
    await redisPub().pexpire(key, PRESENCE_TTL_MS);
  } catch (err) {
    log.warn("presence: redis addConnection failed", {
      paneId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function removeConnection(
  paneId: string,
  connId: string,
): Promise<void> {
  if (!redisEnabled()) {
    const perSession = connections.get(paneId);
    if (!perSession) return;
    perSession.delete(connId);
    if (perSession.size === 0) connections.delete(paneId);
    return;
  }
  try {
    await redisPub().hdel(presenceKey(paneId), connId);
  } catch (err) {
    log.warn("presence: redis removeConnection failed", {
      paneId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Refresh a pane's presence-hash TTL. Called by the WS heartbeat for every
 * pane that still has a live socket on this replica, so a genuinely-active
 * pane never expires. No-op when Redis is off (the in-process Map has no
 * TTL — a crashed single replica takes its whole process with it).
 */
export async function refreshSession(paneId: string): Promise<void> {
  if (!redisEnabled()) return;
  try {
    await redisPub().pexpire(presenceKey(paneId), PRESENCE_TTL_MS);
  } catch (err) {
    log.warn("presence: redis refreshSession failed", {
      paneId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Read every connId -> kind entry for a pane, from whichever backend.
async function readSession(paneId: string): Promise<Map<string, ConnKind>> {
  if (!redisEnabled()) {
    return connections.get(paneId) ?? new Map();
  }
  try {
    const hash = await redisPub().hgetall(presenceKey(paneId));
    const m = new Map<string, ConnKind>();
    for (const [connId, kind] of Object.entries(hash)) {
      m.set(connId, kind === "agent" ? "agent" : "human");
    }
    return m;
  } catch (err) {
    log.warn("presence: redis readSession failed", {
      paneId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

// How many agent-kind sockets are open on this pane right now.
export async function agentCount(paneId: string): Promise<number> {
  const perSession = await readSession(paneId);
  let n = 0;
  for (const kind of perSession.values()) if (kind === "agent") n++;
  return n;
}

// How many sockets (of any kind) are open on this pane right now. Used to
// enforce the per-pane WebSocket connection cap at upgrade time.
export async function connectionCount(paneId: string): Promise<number> {
  const perSession = await readSession(paneId);
  return perSession.size;
}

// How many human-kind sockets are open on this pane right now.
export async function humanCount(paneId: string): Promise<number> {
  const perSession = await readSession(paneId);
  let n = 0;
  for (const kind of perSession.values()) if (kind === "human") n++;
  return n;
}

// Total open WebSocket connections across every pane, optionally filtered
// by author kind. Backs the `pane_ws_connections_active` ObservableGauge — the
// telemetry layer reads this on each metrics collection rather than wiring
// counter increments into the connect/close paths.
//
// REDIS OFF: iterate the in-process Map. REDIS ON: scan presence hashes. The
// SCAN is acceptable here because the gauge is read at the metrics scrape
// cadence (~15s), not on the hot path.
export async function totalConnections(kind?: ConnKind): Promise<number> {
  if (!redisEnabled()) {
    let n = 0;
    for (const perSession of connections.values()) {
      if (kind === undefined) {
        n += perSession.size;
      } else {
        for (const k of perSession.values()) if (k === kind) n++;
      }
    }
    return n;
  }
  try {
    const keys = await redisPub().keys(PRESENCE_PREFIX + "*");
    let n = 0;
    for (const key of keys) {
      const paneId = key.slice(PRESENCE_PREFIX.length);
      const perSession = await readSession(paneId);
      if (kind === undefined) {
        n += perSession.size;
      } else {
        for (const k of perSession.values()) if (k === kind) n++;
      }
    }
    return n;
  } catch (err) {
    log.warn("presence: redis totalConnections failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// Test-only: clear the in-process registry between tests.
export function _resetPresenceForTests(): void {
  connections.clear();
}
