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

export interface SerializedEvent {
  id: string;
  session_id: string;
  author: { kind: AuthorKind; id: string };
  ts: string;
  type: string;
  data: unknown;
  causation_id: string | null;
  idempotency_key: string | null;
}
