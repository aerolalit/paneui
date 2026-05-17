// Agent-friendly API errors. Pane's consumers are AI agents, so every error
// carries enough signal for an agent to decide whether to retry (`retryable`),
// how to fix its input (`hint`), and where to read more (`docsUrl`).

// No hosted docs site yet — link the repo SPEC with verified heading anchors.
const SPEC = "https://github.com/aerolalit/pane/blob/main/docs/SPEC.md";
const DOCS = {
  auth: `${SPEC}#auth-three-layers-only-1-and-2-in-v1`,
  api: `${SPEC}#http-api-v1`,
  schema: `${SPEC}#per-session-event-schema`,
  validation: `${SPEC}#validation-flow`,
  event: `${SPEC}#event-the-only-primitive`,
  rateLimit: `${SPEC}#security-checklist`,
} as const;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
    public readonly hint?: string,
    public readonly retryable?: boolean,
    public readonly docsUrl?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

export const errors = {
  unauthorized: () =>
    new ApiError(
      401,
      "unauthorized",
      undefined,
      undefined,
      "the request needs a valid bearer token: an agent API key for /v1 endpoints, or a participant token for /s endpoints",
      false,
      DOCS.auth,
    ),

  forbidden: (code = "forbidden", message?: string, hint?: string) =>
    new ApiError(
      403,
      code,
      message,
      undefined,
      hint ??
        "the authenticated identity is not permitted to perform this action",
      false,
      DOCS.auth,
    ),

  notFound: () =>
    new ApiError(
      404,
      "not_found",
      undefined,
      undefined,
      "the session or resource id may be wrong, or the session expired and was cleaned up; verify the id and create a new session if needed",
      false,
      DOCS.api,
    ),

  invalidRequest: (message?: string, details?: unknown, hint?: string) =>
    new ApiError(
      400,
      "invalid_request",
      message,
      details,
      hint ??
        "the request body or parameters are malformed; check the field named in the message against the API spec",
      false,
      DOCS.api,
    ),

  payloadTooLarge: () =>
    new ApiError(
      413,
      "payload_too_large",
      undefined,
      undefined,
      "the payload exceeds the configured size cap (MAX_ARTIFACT_BYTES for artifacts, MAX_EVENT_DATA_BYTES for event data); send a smaller payload",
      false,
      DOCS.api,
    ),

  tooManyRequests: (message?: string) =>
    new ApiError(
      429,
      "rate_limited",
      message,
      undefined,
      "the rate limit was exceeded; wait before retrying — back off and try the request again",
      true,
      DOCS.rateLimit,
    ),

  conflict: (message?: string, retryable = false, hint?: string) =>
    new ApiError(
      409,
      "conflict",
      message,
      undefined,
      hint ?? "the request conflicts with the current state of the resource",
      retryable,
      DOCS.api,
    ),

  gone: (message = "session is closed") =>
    new ApiError(
      410,
      "gone",
      message,
      undefined,
      "the session is closed or expired and cannot accept new events; create a new session to continue",
      false,
      DOCS.api,
    ),

  schemaViolation: (code: string, details?: unknown, hint?: string) =>
    new ApiError(
      422,
      code,
      undefined,
      details,
      hint ??
        "the event does not satisfy the session's event schema; check the event type and payload against the declared schema",
      false,
      DOCS.schema,
    ),
};

/** The wire shape of a serialised error envelope's `error` object. */
export interface SerializedApiError {
  code: string;
  message: string;
  hint?: string;
  retryable?: boolean;
  docs_url?: string;
  details?: unknown;
}

/**
 * Serialise an ApiError to the wire `error` object. Additive fields
 * (`hint`/`retryable`/`docs_url`) use snake_case and are omitted when
 * undefined. Shared by the HTTP `onError` handler and the WS frame handler so
 * both transports emit an identical error shape.
 */
export function serializeApiError(err: ApiError): SerializedApiError {
  const body: SerializedApiError = { code: err.code, message: err.message };
  if (err.hint !== undefined) body.hint = err.hint;
  if (err.retryable !== undefined) body.retryable = err.retryable;
  if (err.docsUrl !== undefined) body.docs_url = err.docsUrl;
  if (err.details !== undefined) body.details = err.details;
  return body;
}
