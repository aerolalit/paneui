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
  schema_version: number;
  artifact_version: number;
  metadata: Record<string, unknown> | null;
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
