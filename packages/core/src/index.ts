// @paneui/core — typed client for the Pane relay HTTP + WebSocket API.
// Pure and framework-free: no argv, no MCP, no server deps.

export { PaneClient, PaneApiError } from "./client.js";
export type {
  ClientOptions,
  RelayResponse,
  CreateArtifactRequest,
  CreateArtifactVersionRequest,
  PatchArtifactMetadataRequest,
  AttachmentRef,
  UploadBlobOptions,
  PresignBlobOptions,
  AttachmentTokenMintResponse,
  ListBlobsOptions,
  AttachmentTokenAuditEntry,
  AttachmentTokenListResponse,
  QueryResponse,
  PaneGrant,
  PaneGrantsList,
  PaneVisibility,
  AccessMode,
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
  createPaneSchema,
  artifactTypeSchema,
  createArtifactSchema,
  createArtifactVersionSchema,
  patchArtifactMetadataSchema,
  feedbackTypeSchema,
  submitFeedbackSchema,
  listPanesStatusSchema,
  listPanesQuerySchema,
  mintParticipantSchema,
  upgradePaneSchema,
} from "./schemas.js";
export type {
  CreatePaneInput,
  ListPanesStatus,
  ListPanesQuery,
  MintParticipantInput,
  UpgradePaneInput,
} from "./schemas.js";

export {
  validateIconEmoji,
  isValidIconEmoji,
  isRasterImageMime,
  RASTER_ICON_MIME_ALLOWLIST,
  MAX_ICON_EMOJI_BYTES,
} from "./icons.js";
export type { RasterIconMime } from "./icons.js";

export {
  MAX_EVENT_TYPE_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_RESPONSE_SNIPPET_LENGTH,
  MAX_FRAME_SNIPPET_LENGTH,
} from "./limits.js";

export type {
  AuthorKind,
  PaneEvent,
  SerializedRecord,
  DeletedRecordRef,
  RecordDeltaMessage,
  Template,
  TemplateType,
  TemplateVersion,
  TemplateRecord,
  TemplateSummary,
  CreateArtifactResponse,
  KeyInfo,
  TasteInfo,
  FeedbackType,
  FeedbackSubmission,
  FeedbackRecord,
  FeedbackPage,
  Callback,
  CreatePaneRequest,
  CreatePaneResponse,
  PaneState,
  EventsPage,
  ParticipantSummary,
  ParticipantsList,
  PaneSummary,
  PanesPage,
  MintParticipantResponse,
  UpgradeBreak,
  UpgradePaneResponse,
  TrashedPaneEntry,
  TrashedTemplateEntry,
  TrashListResponse,
  RelayError,
} from "./types.js";
