// Shared, type-level definition of the shell <-> iframe postMessage protocol.
//
// The shell (shell.client.ts) and the runtime (runtime.client.ts) are compiled
// into two SEPARATE IIFE bundles and inlined into different HTML pages — they
// never share a runtime module, and `loadClient()` strips module syntax so a
// runtime `import` would be a SyntaxError in the classic <script> they're
// inlined as.
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
 * Both the shell and the runtime must check an inbound frame's `v` against
 * this before acting on it — a mismatch means the two bundles disagree.
 */
export type PaneProtocolVersion = 1;

/** Frame kinds the runtime sends to the shell (iframe -> shell). */
export type RuntimeToShellKind =
  | "ready"
  | "emit"
  | "upload-attachment-request"
  | "download-attachment-request"
  | "save-attachment-request";

/** Frame kinds the shell sends to the runtime (shell -> iframe). */
export type ShellToRuntimeKind =
  | "init"
  | "event"
  | "ack"
  | "error"
  | "upload-attachment-result"
  | "download-attachment-result"
  | "save-attachment-result";

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
  kind: RuntimeToShellKind | ShellToRuntimeKind;
}

/**
 * A attachment reference returned by the participant-side upload route
 * (`POST /s/:participantToken/attachments`) and surfaced to the iframe by the
 * shell. Mirrors the wire shape `POST /v1/attachments` already returns — kept
 * here as a structural type so the iframe bundle doesn't need to pull in
 * `@paneui/core`.
 */
export interface AttachmentRefLike {
  attachment_id: string;
  scope: "agent" | "surface" | "template";
  mime: string;
  size: number;
  sha256: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  status: string;
  surface_id: string | null;
  template_id: string | null;
  created_at: string;
  confirmed_at: string | null;
  deleted_at: string | null;
}

/**
 * The shape of an `upload-attachment-request` frame the runtime posts to the shell.
 * `file` is a browser `File` — postMessage's structured-clone algorithm
 * supports `File` (and the underlying `Blob` reference), so the shell
 * receives a live `File` it can hand to FormData without a roundtrip
 * through base64/ArrayBuffer.
 */
export interface UploadBlobRequestFrame {
  __pane: PaneFrameMarker;
  v: PaneProtocolVersion;
  kind: "upload-attachment-request";
  /** RPC correlation id — the runtime's resolver matches against this. */
  id: string;
  /** The file the human picked, transferred via structured clone. */
  file: File;
  options?: {
    /** Override the multipart filename (UX-only). */
    filename?: string;
    /** Override the declared Content-Type the shell forwards on the file part. */
    mime?: string;
  };
}

/**
 * The shape of the shell's reply. Discriminated by `ok` — matching the way
 * existing frames discriminate inside an `error` field would have made the
 * success path's AttachmentRef carry an awkward optional field. The new frame
 * uses an explicit boolean for clarity at the call site.
 */
export type UploadBlobResultFrame = {
  __pane: PaneFrameMarker;
  v: PaneProtocolVersion;
  kind: "upload-attachment-result";
  /** Matches the request's `id`. */
  id: string;
} & (
  | { ok: true; attachment: AttachmentRefLike }
  | { ok: false; error: { code: string; message: string } }
);

/**
 * The shape of a `download-attachment-request` frame the runtime posts to the shell.
 * The shell brokers a `GET /s/:participantToken/attachments/:attachment_id` fetch on
 * the iframe's behalf and posts the bytes back as a `Blob` (structured-
 * cloneable across postMessage, same as `File` in the upload direction).
 *
 * Follow-up D of #156 — the symmetric counterpart to UploadBlobRequestFrame.
 */
export interface DownloadBlobRequestFrame {
  __pane: PaneFrameMarker;
  v: PaneProtocolVersion;
  kind: "download-attachment-request";
  /** RPC correlation id — the runtime's resolver matches against this. */
  id: string;
  /** The attachment id to fetch. Must be referenced from this surface. */
  attachment_id: string;
}

/**
 * The shape of the shell's reply. Discriminated by `ok` (matches the
 * upload-attachment-result frame's pattern). On success, the iframe receives a
 * live `Blob` it can hand to `URL.createObjectURL()` and set as `img.src`
 * — the iframe's CSP allows `attachment:` URLs in `img-src`.
 */
export type DownloadBlobResultFrame = {
  __pane: PaneFrameMarker;
  v: PaneProtocolVersion;
  kind: "download-attachment-result";
  /** Matches the request's `id`. */
  id: string;
} & (
  | { ok: true; attachment: Blob; mime: string; size: number }
  | { ok: false; error: { code: string; message: string } }
);

/**
 * `save-attachment-request` — iframe asks the shell to trigger a browser download
 * (save to disk / Files / Photos). The shell does it from the OUTER, non-
 * sandboxed document — so `<a download href="attachment:...">` works reliably,
 * including on iOS Safari (WebKit, where iOS Chrome lives) which silently
 * drops download attempts from inside a sandboxed iframe even with
 * `allow-downloads`.
 *
 * Distinct from `download-attachment-request` (which returns the bytes as a Blob
 * for in-iframe rendering) — `save-attachment-request` returns no payload, only
 * an ok / error ack once the download has been kicked off.
 */
export interface SaveBlobRequestFrame {
  __pane: PaneFrameMarker;
  v: PaneProtocolVersion;
  kind: "save-attachment-request";
  /** RPC correlation id. */
  id: string;
  /** The attachment id to save. Must be referenced from this surface. */
  attachment_id: string;
  /** Suggested filename; the shell uses it on the `<a download>` attribute. */
  filename?: string;
}

/** The shell's ack for a save-attachment-request. Discriminated by `ok`. */
export type SaveBlobResultFrame = {
  __pane: PaneFrameMarker;
  v: PaneProtocolVersion;
  kind: "save-attachment-result";
  id: string;
} & ({ ok: true } | { ok: false; error: { code: string; message: string } });

/**
 * The `payload` carried by the shell -> iframe `init` frame. The shell sends
 * this exactly once, after the iframe has signalled `ready` and event replay
 * has completed.
 */
export interface PaneInitPayload {
  /** The surface id. */
  surface_id: string;
  /** The surface's event schema (the event vocabulary). */
  schema: unknown;
  /** Historical events to replay through the runtime's ingest path. */
  replay: unknown[];
  /** Origin of the shell page — outbound posts from the runtime pin to it. */
  shell_origin: string;
  /**
   * The surface's per-instance `input_data` — validated by the relay against
   * the template version's `input_schema` at surface-create time. `null` when
   * the surface was created without `input_data`. The runtime exposes it on the
   * frozen `window.pane` as `pane.inputData`.
   */
  input_data: unknown;
}
