// @paneui/core — typed client for the Pane relay HTTP + WebSocket API.
// Pure and framework-free: no argv, no MCP, no server deps.

export { PaneClient, PaneApiError } from "./client.js";
export type {
  ClientOptions,
  RelayResponse,
  CreateArtifactRequest,
  CreateArtifactVersionRequest,
  PatchArtifactMetadataRequest,
  BlobRef,
  UploadBlobOptions,
  PresignBlobOptions,
  BlobTokenMintResponse,
} from "./client.js";

export { openStream } from "./stream.js";
export type {
  OpenStreamOptions,
  StreamHandlers,
  StreamHandle,
} from "./stream.js";

export { registerAgent } from "./register.js";
export type { RegisterAgentOptions, RegisterAgentResult } from "./register.js";

export {
  artifactSchema,
  callbackSchema,
  createSessionSchema,
  artifactTypeSchema,
  createArtifactSchema,
  createArtifactVersionSchema,
  patchArtifactMetadataSchema,
  feedbackTypeSchema,
  submitFeedbackSchema,
  listSessionsStatusSchema,
  listSessionsQuerySchema,
  mintParticipantSchema,
} from "./schemas.js";
export type {
  CreateSessionInput,
  ListSessionsStatus,
  ListSessionsQuery,
  MintParticipantInput,
} from "./schemas.js";

export {
  MAX_EVENT_TYPE_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_RESPONSE_SNIPPET_LENGTH,
  MAX_FRAME_SNIPPET_LENGTH,
} from "./limits.js";

export type {
  AuthorKind,
  PaneEvent,
  Artifact,
  ArtifactType,
  ArtifactVersion,
  ArtifactRecord,
  ArtifactSummary,
  CreateArtifactResponse,
  KeyInfo,
  TasteInfo,
  FeedbackType,
  FeedbackSubmission,
  FeedbackRecord,
  FeedbackPage,
  Callback,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionState,
  EventsPage,
  ParticipantSummary,
  ParticipantsList,
  SessionSummary,
  SessionsPage,
  MintParticipantResponse,
  RelayError,
} from "./types.js";
