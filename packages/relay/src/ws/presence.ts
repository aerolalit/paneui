// Real-time agent-presence registry.
//
// Tracks, per session, the set of currently-open WebSocket connections and
// their author kind. This is LIVE runtime state — the single source of truth
// for "is an agent connected RIGHT NOW". It deliberately does NOT derive from
// the persisted `system.participant.joined`/`left` event log: a `left` event
// is written fire-and-forget and can be lost (relay restart, insert failure),
// which would leave a stale `joined` replayed forever. Connection lifecycle is
// the only reliable signal, so we track it here directly.
//
// NOTE: in-memory and single-process. A multi-process relay deployment would
// need shared state (same caveat as the in-app rate limiter). For v1 the relay
// runs as a single process, so a Map is correct and sufficient.

type ConnKind = "agent" | "human";

// sessionId -> (connId -> kind)
const connections = new Map<string, Map<string, ConnKind>>();

export function addConnection(
  sessionId: string,
  connId: string,
  kind: ConnKind,
): void {
  let perSession = connections.get(sessionId);
  if (!perSession) {
    perSession = new Map();
    connections.set(sessionId, perSession);
  }
  perSession.set(connId, kind);
}

export function removeConnection(sessionId: string, connId: string): void {
  const perSession = connections.get(sessionId);
  if (!perSession) return;
  perSession.delete(connId);
  if (perSession.size === 0) connections.delete(sessionId);
}

// How many agent-kind sockets are open on this session right now.
export function agentCount(sessionId: string): number {
  const perSession = connections.get(sessionId);
  if (!perSession) return 0;
  let n = 0;
  for (const kind of perSession.values()) if (kind === "agent") n++;
  return n;
}

// How many sockets (of any kind) are open on this session right now. Used to
// enforce the per-session WebSocket connection cap at upgrade time.
export function connectionCount(sessionId: string): number {
  return connections.get(sessionId)?.size ?? 0;
}

// How many human-kind sockets are open on this session right now.
export function humanCount(sessionId: string): number {
  const perSession = connections.get(sessionId);
  if (!perSession) return 0;
  let n = 0;
  for (const kind of perSession.values()) if (kind === "human") n++;
  return n;
}

// Total open WebSocket connections across every session, optionally filtered
// by author kind. Backs the `pane_ws_connections_active` ObservableGauge — the
// telemetry layer reads this on each metrics collection rather than wiring
// counter increments into the connect/close paths.
export function totalConnections(kind?: ConnKind): number {
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
