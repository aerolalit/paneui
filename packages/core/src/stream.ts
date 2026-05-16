// WebSocket client for WS /v1/sessions/:id/stream.
//
// The relay protocol (see the relay's src/ws/handler.ts):
//   - on connect, the relay replays every event since `?since=` (or from the
//     start), then sends a `{ kind: "system.replay.complete" }` marker;
//   - thereafter it pushes live events as they land;
//   - each frame is a JSON object: either a PaneEvent envelope, the replay
//     marker, an `{ ack, deduped }` for frames we sent, or an `{ error }`.
//
// `openStream` exposes this as a typed event emitter over the `ws` package.

import { WebSocket } from "ws";
import type { PaneEvent } from "./types.js";

export interface OpenStreamOptions {
  /** WebSocket base URL, e.g. wss://pane.example.com (no trailing slash). */
  wsBaseUrl: string;
  /** Session id. */
  sessionId: string;
  /** Agent (or participant) bearer token. */
  token: string;
  /** Opaque cursor: replay only events strictly after this id. */
  since?: string | null;
}

/** Callbacks for a live stream. */
export interface StreamHandlers {
  /** Fired for every event envelope (replayed and live). */
  onEvent?: (event: PaneEvent) => void;
  /** Fired once when the initial replay finishes. */
  onReplayComplete?: () => void;
  /** Fired on a relay error frame. */
  onRelayError?: (error: { code?: string; message?: string; details?: unknown }) => void;
  /** Fired when the socket closes (cleanly or otherwise). */
  onClose?: (info: { code: number; reason: string }) => void;
  /** Fired on a transport-level error. */
  onError?: (err: Error) => void;
}

/** A live handle to an open stream. */
export interface StreamHandle {
  /** Send an event frame into the session. */
  send(frame: { type: string; data?: unknown; causation_id?: string; idempotency_key?: string }): void;
  /** Close the stream. */
  close(): void;
  /** The underlying ws socket (escape hatch). */
  readonly socket: WebSocket;
}

/**
 * Open a WebSocket stream to a Pane session. Replays on connect, then streams
 * live. Returns a handle for sending frames and closing.
 */
export function openStream(opts: OpenStreamOptions, handlers: StreamHandlers): StreamHandle {
  const base = opts.wsBaseUrl.replace(/\/$/, "");
  const u = new URL(`${base}/v1/sessions/${encodeURIComponent(opts.sessionId)}/stream`);
  if (opts.since != null && opts.since !== "") {
    u.searchParams.set("since", opts.since);
  }
  // Token via Authorization header (Node ws supports it); the relay also
  // accepts ?token= but the header keeps it out of any URL access log.
  const socket = new WebSocket(u.toString(), {
    headers: { authorization: "Bearer " + opts.token },
  });

  socket.on("message", (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const obj = msg as Record<string, unknown>;

    if (obj["kind"] === "system.replay.complete") {
      handlers.onReplayComplete?.();
      return;
    }
    if ("error" in obj) {
      handlers.onRelayError?.(
        obj["error"] as { code?: string; message?: string; details?: unknown },
      );
      return;
    }
    if ("ack" in obj) {
      // Ack for a frame we sent; nothing to surface by default.
      return;
    }
    if (typeof obj["id"] === "string" && typeof obj["type"] === "string") {
      handlers.onEvent?.(obj as unknown as PaneEvent);
    }
  });

  socket.on("close", (code, reason) => {
    handlers.onClose?.({ code, reason: reason.toString() });
  });

  socket.on("error", (err) => {
    handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    send(frame) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    },
    close() {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    },
    get socket() {
      return socket;
    },
  };
}
