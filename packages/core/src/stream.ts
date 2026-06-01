// WebSocket client for WS /v1/surfaces/:id/stream.
//
// The relay protocol (see the relay's src/ws/handler.ts):
//   - on connect, the relay replays every event since `?since=` (or from the
//     start), then sends a `{ kind: "system.replay.complete" }` marker;
//   - thereafter it pushes live events as they land;
//   - each frame is a JSON object: either a PaneEvent envelope, the replay
//     marker, an `{ ack, deduped }` for frames we sent, or an `{ error }`.
//
// Note: `system.participant.joined` / `system.participant.left` (and other
// `system.*` events) arrive as ordinary `PaneEvent` envelopes — they are not a
// distinct frame kind, and may be interleaved with the initial replay stream
// just like any other event.
//
// `openStream` exposes this as a typed event emitter over the `ws` package.

import { WebSocket } from "ws";
import type { PaneEvent, RecordDeltaMessage } from "./types.js";
import { MAX_FRAME_SNIPPET_LENGTH } from "./limits.js";

export interface OpenStreamOptions {
  /** WebSocket base URL, e.g. wss://pane.example.com (no trailing slash). */
  wsBaseUrl: string;
  /** Surface id. */
  surfaceId: string;
  /** Agent (or participant) bearer token. */
  token: string;
  /** Opaque cursor: replay only events strictly after this id. */
  since?: string | null;
  /**
   * #297 — subscribe to record-collection deltas. `"*"` expands to every
   * declared collection on the surface's template; a comma list filters
   * to those names. Absent = no record traffic (legacy event-only stream).
   */
  subscribeRecords?: string;
  /**
   * #297 — per-collection record-replay cursors. Map of collection name →
   * last observed seq, sent as `?since_record_seq.<name>=<seq>` so the
   * relay's replay (#295) skips already-observed rows on reconnect.
   */
  sinceRecordSeq?: Record<string, number>;
}

/** Callbacks for a live stream. */
export interface StreamHandlers {
  /** Fired for every event envelope (replayed and live). */
  onEvent?: (event: PaneEvent) => void;
  /** Fired once when the initial event replay finishes. */
  onReplayComplete?: () => void;
  /**
   * #297 — fired for every record-delta message (record.upsert /
   * record.delete / record.replay.complete) on the stream. Per-collection
   * record.replay.complete fires once per subscribed collection after
   * the replay set has been drained.
   */
  onRecord?: (msg: RecordDeltaMessage) => void;
  /** Fired on a relay error frame. */
  onRelayError?: (error: {
    code?: string;
    message?: string;
    details?: unknown;
  }) => void;
  /** Fired when the socket closes (cleanly or otherwise). */
  onClose?: (info: { code: number; reason: string }) => void;
  /** Fired on a transport-level error. */
  onError?: (err: Error) => void;
}

/** A live handle to an open stream. */
export interface StreamHandle {
  /** Send an event frame into the surface. */
  send(frame: {
    type: string;
    data?: unknown;
    causation_id?: string;
    idempotency_key?: string;
  }): void;
  /** Close the stream. */
  close(): void;
  /** The underlying ws socket (escape hatch). */
  readonly socket: WebSocket;
}

/**
 * Open a WebSocket stream to a Pane surface. Replays on connect, then streams
 * live. Returns a handle for sending frames and closing.
 */
export function openStream(
  opts: OpenStreamOptions,
  handlers: StreamHandlers,
): StreamHandle {
  const base = opts.wsBaseUrl.replace(/\/$/, "");
  const u = new URL(
    `${base}/v1/surfaces/${encodeURIComponent(opts.surfaceId)}/stream`,
  );
  if (opts.since != null && opts.since !== "") {
    u.searchParams.set("since", opts.since);
  }
  if (opts.subscribeRecords && opts.subscribeRecords.length > 0) {
    u.searchParams.set("subscribe_records", opts.subscribeRecords);
  }
  if (opts.sinceRecordSeq) {
    for (const [name, seq] of Object.entries(opts.sinceRecordSeq)) {
      u.searchParams.set(`since_record_seq.${name}`, String(seq));
    }
  }
  // Token via Authorization header (Node ws supports it); the relay also
  // accepts ?token= but the header keeps it out of any URL access log.
  const socket = new WebSocket(u.toString(), {
    headers: { authorization: "Bearer " + opts.token },
  });

  socket.on("message", (raw) => {
    const text = raw.toString();
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      // A malformed frame must never be silently dropped — a dropped event
      // makes `watch --type X` hang forever. Surface it as a transport error.
      const snippet =
        text.length > MAX_FRAME_SNIPPET_LENGTH
          ? text.slice(0, MAX_FRAME_SNIPPET_LENGTH) + "…"
          : text;
      handlers.onError?.(
        new Error(
          `failed to parse stream frame as JSON (${
            e instanceof Error ? e.message : String(e)
          }): ${snippet}`,
        ),
      );
      return;
    }
    if (!msg || typeof msg !== "object") {
      handlers.onError?.(
        new Error(
          `unexpected non-object stream frame: ${text.slice(0, MAX_FRAME_SNIPPET_LENGTH)}`,
        ),
      );
      return;
    }
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
    // #297 — record deltas. record.upsert / record.delete / record.replay.complete.
    const kind = obj["kind"];
    if (
      kind === "record.upsert" ||
      kind === "record.delete" ||
      kind === "record.replay.complete"
    ) {
      handlers.onRecord?.(obj as unknown as RecordDeltaMessage);
      return;
    }
    if (typeof obj["id"] === "string" && typeof obj["type"] === "string") {
      handlers.onEvent?.(obj as unknown as PaneEvent);
      return;
    }
    // Unrecognized frame shape — route to onError rather than dropping it.
    handlers.onError?.(
      new Error(
        `unrecognized stream frame: ${JSON.stringify(obj).slice(0, MAX_FRAME_SNIPPET_LENGTH)}`,
      ),
    );
  });

  socket.on("close", (code, reason) => {
    handlers.onClose?.({ code, reason: reason.toString() });
  });

  socket.on("error", (err) => {
    handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    send(frame) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error(
          `cannot send frame: stream socket is not open (readyState=${socket.readyState})`,
        );
      }
      socket.send(JSON.stringify(frame));
    },
    close() {
      try {
        socket.close();
      } catch (e) {
        console.debug(
          "[pane] stream close error:",
          e instanceof Error ? e.message : String(e),
        );
      }
    },
    get socket() {
      return socket;
    },
  };
}
