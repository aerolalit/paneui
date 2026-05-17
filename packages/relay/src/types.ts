import type { PaneEvent } from "@pane/core";

export type AuthorKind = "human" | "agent" | "system";

export interface Author {
  kind: AuthorKind;
  id: string;
}

export type EmittedBy = "page" | "agent";

export interface EventSchemaEntry {
  payload: object;
  emittedBy: EmittedBy[];
}

export interface EventSchema {
  events: Record<string, EventSchemaEntry>;
}

/**
 * A single event envelope as emitted by the relay over HTTP/WebSocket.
 *
 * This is the same wire shape as `@pane/core`'s `PaneEvent` — the relay
 * produces it, `@pane/core` consumes it. It is aliased here (rather than
 * re-declared) so the producer and consumer definitions cannot drift; see
 * issue #58. `SerializedEvent` is kept as the relay-facing name.
 */
export type SerializedEvent = PaneEvent;
