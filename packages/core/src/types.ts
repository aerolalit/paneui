// Wire types for the Pane relay HTTP + WebSocket API.
//
// These mirror the relay's public response shapes (see the relay's
// src/types.ts, src/http/serialize.ts and src/http/routes/*). They are
// re-declared here rather than imported from @pane/relay so that @pane/core
// stays pure and framework-free — no Prisma, no Hono, no server deps.

import type { z } from "zod";
import type { createSessionSchema } from "./schemas.js";

export type AuthorKind = "human" | "agent" | "system";

/** A single event envelope as emitted by the relay. */
export interface PaneEvent {
  id: string;
  session_id: string;
  author: { kind: AuthorKind; id: string };
  ts: string;
  type: string;
  data: unknown;
  causation_id: string | null;
  idempotency_key: string | null;
}

/** The artifact content type. `html-ref` is rejected by the relay for now. */
export type ArtifactType = "html-inline" | "html-ref";

/**
 * An artifact: discriminated on `type`. `html-inline` carries raw HTML in
 * `source`; `html-ref` carries a URL the relay/shell fetches on the human's
 * behalf. The discriminant keeps the type↔source coupling explicit.
 */
export type Artifact =
  | { type: "html-inline"; source: string }
  | { type: "html-ref"; source: string };

/** Optional webhook callback config. */
export interface Callback {
  url: string;
  events: string[];
  secret: string;
}

/**
 * Request body for POST /v1/sessions. Derived from `createSessionSchema` so the
 * runtime validator and the static type cannot drift.
 */
export type CreateSessionRequest = z.infer<typeof createSessionSchema>;

/** Response from POST /v1/sessions. */
export interface CreateSessionResponse {
  session_id: string;
  tokens: { humans: string[]; agent: string };
  urls: { humans: string[]; agent_stream: string };
  expires_at: string;
}

/** Response from GET /v1/sessions/:id. */
export interface SessionState {
  session_id: string;
  status: string;
  /** The artifact version this session is pinned to. */
  artifact_id: string;
  artifact_version_id: string;
  artifact_version: number;
  metadata: Record<string, unknown> | null;
  input_data: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
}

/** Response from GET /v1/sessions/:id/events. */
export interface EventsPage {
  events: PaneEvent[];
  next_cursor: string | null;
}

/** One immutable version of an artifact's content. */
export interface ArtifactVersion {
  id: string;
  version: number;
  type: ArtifactType;
  source: string;
  event_schema: unknown;
  input_schema: Record<string, unknown> | null;
  created_at: string;
}

/** A full artifact — head metadata plus its version list. */
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
  versions: ArtifactVersion[];
}

/**
 * A full artifact — head metadata plus its version list. (`ArtifactRecord` is
 * the public name; `Artifact` is kept as the older inline-artifact union.)
 */
export type ArtifactRecord = Artifact_;

/**
 * A lean artifact summary for list/search responses — head metadata only, no
 * `source` blob. See GET /v1/artifacts.
 */
export interface ArtifactSummary {
  id: string;
  slug: string | null;
  name: string | null;
  description: string | null;
  tags: string[] | null;
  latest_version: number;
  last_used_at: string | null;
}

/** Response from POST /v1/artifacts and POST /v1/artifacts/:id/versions. */
export interface CreateArtifactResponse {
  artifact_id: string;
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
