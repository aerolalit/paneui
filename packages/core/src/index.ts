// @pane/core — typed client for the Pane relay HTTP + WebSocket API.
// Pure and framework-free: no argv, no MCP, no server deps.

export { PaneClient, PaneApiError } from "./client.js";
export type { ClientOptions, RelayResponse } from "./client.js";

export { openStream } from "./stream.js";
export type { OpenStreamOptions, StreamHandlers, StreamHandle } from "./stream.js";

export {
  artifactSchema,
  callbackSchema,
  createSessionSchema,
} from "./schemas.js";
export type { CreateSessionInput } from "./schemas.js";

export type {
  AuthorKind,
  PaneEvent,
  Artifact,
  Callback,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionState,
  EventsPage,
  RelayError,
} from "./types.js";
