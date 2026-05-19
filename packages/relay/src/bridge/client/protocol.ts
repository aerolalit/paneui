// Shared, type-level definition of the shell <-> iframe postMessage protocol.
//
// The shell (shell.client.ts) and the shim (shim.client.ts) are compiled into
// two SEPARATE IIFE bundles and inlined into different HTML pages — they never
// share a runtime module, and `loadClient()` strips module syntax so a runtime
// `import` would be a SyntaxError in the classic <script> they're inlined as.
//
// So this file is deliberately TYPE-ONLY: it declares no runtime values, only
// interfaces and type aliases. Both bundles `import type` from it, which the
// compiler fully erases — nothing is added to either IIFE. Yet because both
// sides are checked against the same definitions, any divergence in the frame
// envelope `{ __pane, v, kind, payload }` is now a compile error even though
// the two bundles are emitted independently. (Issue #58.)

/** Magic marker stamped on every Pane protocol frame: the literal `1`. */
export type PaneFrameMarker = 1;

/**
 * Protocol version literal. Bumped on any breaking change to the frame shape.
 * Both the shell and the shim must check an inbound frame's `v` against this
 * before acting on it — a mismatch means the two bundles disagree.
 */
export type PaneProtocolVersion = 1;

/** Frame kinds the shim sends to the shell (iframe -> shell). */
export type ShimToShellKind = "ready" | "emit";

/** Frame kinds the shell sends to the shim (shell -> iframe). */
export type ShellToShimKind = "init" | "event" | "ack" | "error";

/**
 * The envelope every Pane protocol frame carries. Concrete frame types in each
 * bundle extend this with `kind`-specific fields (`payload`, `correlation_id`,
 * …). Both sides validate `__pane` and `v` on every inbound frame.
 */
export interface PaneFrameEnvelope {
  /** Always `1` — distinguishes a Pane frame from unrelated postMessage noise. */
  __pane: PaneFrameMarker;
  /** Always `1` — receivers reject any other value before acting on the frame. */
  v: PaneProtocolVersion;
  /** Discriminates the frame; the remaining fields depend on it. */
  kind: ShimToShellKind | ShellToShimKind;
}

/**
 * The `payload` carried by the shell -> iframe `init` frame. The shell sends
 * this exactly once, after the iframe has signalled `ready` and event replay
 * has completed.
 */
export interface PaneInitPayload {
  /** The session id. */
  session_id: string;
  /** The session's event schema (the event vocabulary). */
  schema: unknown;
  /** Historical events to replay through the shim's ingest path. */
  replay: unknown[];
  /** Origin of the shell page — outbound posts from the shim pin to it. */
  shell_origin: string;
  /**
   * The session's per-instance `input_data` — validated by the relay against
   * the artifact version's `input_schema` at session-create time. `null` when
   * the session was created without `input_data`. The shim exposes it on the
   * frozen `window.pane` as `pane.inputData`.
   */
  input_data: unknown;
}
