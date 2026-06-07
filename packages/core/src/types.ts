// Wire types for the Pane relay HTTP + WebSocket API.
//
// These mirror the relay's public response shapes (see the relay's
// src/types.ts, src/http/serialize.ts and src/http/routes/*). They are
// re-declared here rather than imported from @paneui/relay so that @paneui/core
// stays pure and framework-free — no Prisma, no Hono, no server deps.

import type { z } from "zod";
import type { createPaneSchema } from "./schemas.js";

export type AuthorKind = "human" | "agent" | "system";

/** A single event envelope as emitted by the relay. */
export interface PaneEvent {
  id: string;
  pane_id: string;
  author: { kind: AuthorKind; id: string };
  ts: string;
  type: string;
  data: unknown;
  causation_id: string | null;
  idempotency_key: string | null;
  /**
   * The template version this event was written under — the pane's pinned
   * templateVersionId at the moment of the write. Stamped at write time and
   * never rewritten, so a downstream upgrade (#267) can read old events
   * under the new schema (Level 1 polymorphic render). Nullable for events
   * written before #268 landed; the relay's one-shot migration backfilled
   * those from the pane's current pin where possible.
   */
  template_version_id: string | null;
  /** Denormalised integer version number for `template_version_id`. */
  template_version: number | null;
}

/**
 * One record on the wire (#287). Returned by the records CRUD routes
 * (#292) and by the WS record-delta messages (#294). Structurally
 * identical to the relay-side SerializedRecord; mirrored here so the
 * core package is self-contained.
 */
export interface SerializedRecord {
  id: string;
  collection: string;
  key: string;
  data: unknown;
  version: number;
  seq: number;
  author: { kind: AuthorKind; id: string };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Wire shape for a soft-deleted record on the WS channel. */
export interface DeletedRecordRef {
  id: string;
  key: string;
  seq: number;
  deleted_at: string;
}

/** Discriminated wire shape for record-state changes. */
export type RecordDeltaMessage =
  | { kind: "record.upsert"; collection: string; record: SerializedRecord }
  | { kind: "record.delete"; collection: string; record: DeletedRecordRef }
  | { kind: "record.replay.complete"; collection: string; seq: number };

/** The template content type. `html-ref` is rejected by the relay for now. */
export type TemplateType = "html-inline" | "html-ref";

/**
 * An template: discriminated on `type`. `html-inline` carries raw HTML in
 * `source`; `html-ref` carries a URL the relay/shell fetches on the human's
 * behalf. The discriminant keeps the type↔source coupling explicit.
 */
export type Template =
  | { type: "html-inline"; source: string }
  | { type: "html-ref"; source: string };

/** Optional webhook callback config. */
export interface Callback {
  url: string;
  events: string[];
  secret: string;
}

/**
 * Request body for POST /v1/panes. Derived from `createPaneSchema` so the
 * runtime validator and the static type cannot drift.
 */
export type CreatePaneRequest = z.infer<typeof createPaneSchema>;

/** Response from POST /v1/panes. */
export interface CreatePaneResponse {
  pane_id: string;
  tokens: { humans: string[]; agent: string };
  urls: { humans: string[]; agent_stream: string };
  expires_at: string;
  /** The resolved tab title persisted on the pane (the agent's value, or
   * the Template.name fallback). */
  title: string;
}

/** Response from GET /v1/panes/:id. */
export interface PaneState {
  pane_id: string;
  status: string;
  /** The template version this pane is pinned to. */
  template_id: string;
  template_version_id: string;
  template_version: number;
  /** The tab title this pane was created with (frozen for its lifetime). */
  title: string;
  metadata: Record<string, unknown> | null;
  input_data: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
}

/** Response from GET /v1/panes/:id/events. */
export interface EventsPage {
  events: PaneEvent[];
  next_cursor: string | null;
}

/** A non-secret summary of one participant on a pane — safe to list. */
export interface ParticipantSummary {
  /** The revoke handle (Participant.id). */
  participant_id: string;
  /** "agent" or "human". The agent's own participant is always present. */
  kind: "agent" | "human";
  /** Short, non-secret correlator for a saved URL ("tok_h_..." / "tok_a_..."). */
  token_prefix: string;
  /** ISO timestamp of first WebSocket connect, or null if never joined. */
  joined_at: string | null;
  /** ISO timestamp the participant was revoked; null while still active. */
  revoked_at: string | null;
}

/** A row in the GET /v1/panes list response (no secrets, lean). */
export interface PaneSummary {
  pane_id: string;
  /** Tab title (required column; agent input or Template.name fallback). */
  title: string;
  /** Effective status — respects expiresAt projection (the column may say
   *  "open" while `expires_at` is in the past; the projection reports "closed"). */
  status: "open" | "closed";
  /** Owning template's head id. Null for inline (anonymous) templates. */
  template_id: string | null;
  template_version_id: string;
  template_version: number;
  /** Count of active (non-revoked) human participants. The full participant
   *  array is intentionally NOT inlined here — agents with many panes
   *  would pay the bandwidth on every list call. Fetch
   *  `GET /v1/panes/:id/participants` when you need the rows. */
  active_human_participants: number;
  created_at: string;
  expires_at: string;
  /** Whether the pane has a webhook callback configured (URL is NOT
   *  returned — it may carry a secret in the path). */
  has_callback: boolean;
}

/** Response from GET /v1/panes/:id/participants — every participant on
 *  one pane (active and revoked). Bounded by MAX_PARTICIPANTS_PER_PANE
 *  on the relay so no pagination is needed. */
export interface ParticipantsList {
  pane_id: string;
  items: ParticipantSummary[];
}

/** Response from GET /v1/panes. */
export interface PanesPage {
  items: PaneSummary[];
  /** Opaque cursor for the next page; null when no more rows. */
  next_cursor: string | null;
}

/** A trashed pane in the GET /v1/trash response (#306). */
export interface TrashedPaneEntry {
  pane_id: string;
  title: string;
  agent_name: string;
  /** ISO-8601 timestamp the pane was soft-deleted. Always present here. */
  deleted_at: string;
}

/** A trashed template in the GET /v1/trash response (#306). */
export interface TrashedTemplateEntry {
  template_id: string;
  name: string | null;
  slug: string | null;
  deleted_at: string;
}

/** Response from GET /v1/trash (#306). */
export interface TrashListResponse {
  panes: TrashedPaneEntry[];
  templates: TrashedTemplateEntry[];
}

/** Response from POST /v1/panes/:id/participants — one-shot, includes the
 *  plaintext token exactly once. The relay stores only the hash. */
export interface MintParticipantResponse {
  participant_id: string;
  kind: "human";
  /** The plaintext participant token. Returned ONCE — not recoverable. */
  token: string;
  /** The shareable human URL containing the token. */
  url: string;
  created_at: string;
}

/** One break flagged by the schema-compat gate when upgrading a pane to a
 *  template version whose schema narrows the current one. */
export interface UpgradeBreak {
  /** JSON-pointer-ish path to the offending schema location. */
  path: string;
  /** Human-readable description of why the change is incompatible. */
  message: string;
}

/** Response from POST /v1/panes/:id/upgrade — the result of re-pinning a live
 *  pane to another version of the same template (#267). */
export interface UpgradePaneResponse {
  pane_id: string;
  /** The version id the pane now points at. */
  template_version_id: string;
  /** Denormalised integer version number the pane now points at. */
  template_version: number;
  /** `false` when the pane was already on the target version (idempotent
   *  no-op); `true` when the re-pin was applied. */
  upgraded: boolean;
  /** Schema-compat breaks detected against the target version. Empty on a
   *  clean upgrade; populated (and applied anyway) on `compat: "force"`. */
  breaks: UpgradeBreak[];
  /** The compat mode the upgrade ran under. */
  compat: "strict" | "force";
}

/** One immutable version of an template's content. */
export interface TemplateVersion {
  id: string;
  version: number;
  type: TemplateType;
  source: string;
  // null = view-only template (no event vocabulary). The `unknown` type
  // subsumes null, so no separate union is needed.
  event_schema: unknown;
  input_schema: Record<string, unknown> | null;
  created_at: string;
}

/** A full template — head metadata plus its version list. */
export interface Artifact_ {
  id: string;
  slug: string | null;
  name: string | null;
  description: string | null;
  tags: string[] | null;
  latest_version: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  versions: TemplateVersion[];
}

/**
 * A full template — head metadata plus its version list. (`TemplateRecord` is
 * the public name; `Template` is kept as the older inline-template union.)
 */
export type TemplateRecord = Artifact_;

/**
 * A lean template summary for list/search responses — head metadata only, no
 * `source` attachment. See GET /v1/templates.
 */
export interface TemplateSummary {
  id: string;
  slug: string | null;
  name: string | null;
  description: string | null;
  tags: string[] | null;
  latest_version: number;
  last_used_at: string | null;
}

/** Response from POST /v1/templates and POST /v1/templates/:id/versions. */
export interface CreateArtifactResponse {
  template_id: string;
  version: number;
}

/**
 * Response from GET /v1/keys — the calling agent's own key info. The relay
 * scopes this to the authenticated agent: it returns ONE key (the caller's),
 * not a list.
 */
export interface KeyInfo {
  agent_id: string;
  name: string | null;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Response from GET /v1/taste, PUT /v1/taste — the calling agent's freeform
 * "taste notes" markdown attachment (presentation preferences the agent has picked
 * up from human feedback over time). `taste` and `updated_at` are null when
 * the agent has never written notes; `bytes` is the utf8 byte length and 0
 * when `taste` is null.
 */
export interface TasteInfo {
  taste: string | null;
  updated_at: string | null;
  bytes: number;
}

/** A feedback `type` discriminant accepted by POST /v1/feedback. */
export type FeedbackType = "bug" | "feature" | "note";

/** Response from POST /v1/feedback — id, type, created_at only (no message echo). */
export interface FeedbackSubmission {
  id: string;
  type: FeedbackType;
  created_at: string;
}

/** A row from GET /v1/feedback — full record including message. */
export interface FeedbackRecord {
  id: string;
  type: FeedbackType;
  message: string;
  pane_id: string | null;
  created_at: string;
}

/** Response from GET /v1/feedback — page of the calling agent's own submissions. */
export interface FeedbackPage {
  items: FeedbackRecord[];
  next_before?: string;
}

/** A relay error envelope. */
export interface RelayError {
  code: string;
  message?: string;
  details?: unknown;
  /** Agent-friendly remediation hint. */
  hint?: string;
  /** Whether retrying the same request may succeed. */
  retryable?: boolean;
  /** Documentation URL for this error class (snake_case on the wire). */
  docs_url?: string;
}
