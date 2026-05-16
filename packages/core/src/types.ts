// Wire types for the Pane relay HTTP + WebSocket API.
//
// These mirror the relay's public response shapes (see the relay's
// src/types.ts, src/http/serialize.ts and src/http/routes/*). They are
// re-declared here rather than imported from @pane/relay so that @pane/core
// stays pure and framework-free — no Prisma, no Hono, no server deps.

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

/** An artifact: either inline HTML or a URL reference. */
export interface Artifact {
  type: "html-inline" | "html-ref";
  source: string;
}

/** Optional webhook callback config. */
export interface Callback {
  url: string;
  events: string[];
  secret: string;
}

/** Request body for POST /v1/sessions. */
export interface CreateSessionRequest {
  artifact: Artifact;
  /** Per-session event schema (opaque object validated by the relay). */
  schema: unknown;
  participants?: { humans: number };
  /** TTL in seconds. */
  ttl?: number;
  metadata?: Record<string, unknown>;
  callback?: Callback;
}

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
  schema_version: number;
  artifact_version: number;
  metadata: unknown;
  created_at: string;
  expires_at: string;
}

/** Response from GET /v1/sessions/:id/events. */
export interface EventsPage {
  events: PaneEvent[];
  next_cursor: string | null;
}

/** A relay error envelope. */
export interface RelayError {
  code: string;
  message?: string;
  details?: unknown;
}
