// Agent-friendly API errors. Pane's consumers are AI agents, so every error
// carries enough signal for an agent to decide whether to retry (`retryable`),
// how to fix its input (`hint`), and where to read more (`docsUrl`).

// No hosted docs site yet — link the repo SPEC with verified heading anchors.
// `/blob/<branch>/<path>` is GitHub's tree-URL infix; it has no relation to
// the product noun rename (Tier 3, #239: blob → attachment) but the rename
// sweep flipped this string anyway, breaking the docs link in every error
// envelope. See #260.
const SPEC = "https://github.com/aerolalit/paneui/blob/main/docs/SPEC.md";
const DOCS = {
  auth: `${SPEC}#auth-three-layers-only-1-and-2-in-v1`,
  api: `${SPEC}#http-api-v1`,
  schema: `${SPEC}#per-surface-event-schema`,
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

  // Generic 404 — still used for endpoints where the missing resource kind
  // isn't worth distinguishing (e.g. a bridge token). For templates, template
  // versions, and surfaces, prefer the dedicated constructors below so an
  // agent can branch on the code instead of parsing the hint.
  notFound: () =>
    new ApiError(
      404,
      "not_found",
      undefined,
      undefined,
      "the resource id may be wrong, or the resource was cleaned up; verify the id and try again",
      false,
      DOCS.api,
    ),

  // Distinct from `not_found` so an agent can act differently when the
  // missing thing is a surface (likely expired/cleaned up) vs an template
  // (likely wrong slug/id) vs an template version (likely wrong --version).
  sessionNotFound: () =>
    new ApiError(
      404,
      "session_not_found",
      undefined,
      undefined,
      "the surface id may be wrong, or the surface expired and was cleaned up; verify the id and create a new surface if needed",
      false,
      DOCS.api,
    ),

  artifactNotFound: () =>
    new ApiError(
      404,
      "artifact_not_found",
      undefined,
      undefined,
      "the template id or slug is wrong, or the template does not belong to the calling agent; run 'pane template list' or 'pane template search' to find the right id",
      false,
      DOCS.api,
    ),

  artifactVersionNotFound: () =>
    new ApiError(
      404,
      "artifact_version_not_found",
      undefined,
      undefined,
      "the requested --version does not exist for this template; run 'pane template show <id|slug>' to list its versions",
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
      "the payload exceeds the configured size cap (MAX_ARTIFACT_BYTES for templates, MAX_EVENT_DATA_BYTES for event data, MAX_TASTE_BYTES for taste notes); send a smaller payload",
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

  gone: (message = "surface is closed") =>
    new ApiError(
      410,
      "gone",
      message,
      undefined,
      "the surface is closed or expired and cannot accept new events; create a new surface to continue",
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
        "the event does not satisfy the surface's event schema; check the event type and payload against the declared schema",
      false,
      DOCS.schema,
    ),

  // #267 — POST /v1/surfaces/:id/upgrade refused because the target
  // template version's schema isn't a superset of the surface's current
  // pinned version. Past events would no longer validate under the new
  // schema. `details.breaks` is the list of specific narrowings from
  // src/core/schema-compat.ts; the operator either resolves them (publish
  // a wider new version, drop the upgrade) or passes compat="force" to
  // skip the gate.
  schemaIncompatibleUpgrade: (
    breaks: Array<{ path: string; message: string }>,
  ) =>
    new ApiError(
      422,
      "schema_incompatible_upgrade",
      undefined,
      { breaks },
      "the target template version narrows the surface's current schema in one or more places; either publish a wider template version that's a superset, or retry with compat=\"force\" to skip the gate (events written under the old schema may no longer validate)",
      false,
      DOCS.schema,
    ),

  // The route is wired but the underlying capability (e.g. presigned PUT
  // against a backend that doesn't support it) isn't available on this
  // relay. 501 is the correct status — the request was well-formed but
  // can't be processed.
  notImplemented: (message: string, hint?: string) =>
    new ApiError(
      501,
      "not_implemented",
      message,
      undefined,
      hint ?? "this relay does not implement the requested capability",
      false,
      DOCS.api,
    ),

  // Returned when a /s/:participantToken/* route is hit with a token that
  // doesn't resolve to a live participant. Collapses all "this token won't
  // work" cases (malformed, unknown, revoked, surface-gone) into one code
  // so a probing client can't distinguish them.
  participantTokenInvalid: () =>
    new ApiError(
      401,
      "participant_token_invalid",
      undefined,
      undefined,
      "the participant token is unknown, malformed, or revoked; the agent can mint a fresh one via POST /v1/surfaces or by revoking + re-creating the surface",
      false,
      DOCS.auth,
    ),

  // Returned when /b/<token> is hit with a token that's expired, revoked,
  // already-used (for once-tokens), or never existed. We collapse all four
  // into one code so an attacker probing tokens can't distinguish "this
  // hash exists but is expired" from "this hash never existed."
  blobTokenInvalid: () =>
    new ApiError(
      401,
      "attachment_token_invalid",
      undefined,
      undefined,
      "the attachment token is unknown, expired, revoked, or has been spent (once-tokens); request a fresh token from the agent that owns the attachment",
      false,
      DOCS.auth,
    ),

  // Distinct from `attachment_not_found` so the route layer (and a future audit
  // log analysis) can tell "this attachment token is gone" from "this attachment token
  // never existed." Same status + hint as blobTokenInvalid by design — the
  // caller has no business knowing which it was.
  blobTokenNotFound: () =>
    new ApiError(
      404,
      "attachment_token_not_found",
      undefined,
      undefined,
      "the token id is wrong, or the token does not belong to this attachment; run 'pane attachment show <id>' to list active tokens",
      false,
      DOCS.api,
    ),

  // Distinct from `not_found` so an agent can branch on the kind of missing
  // resource (a attachment lookup typically follows a known attachment_id, so a 404 here
  // means the agent guessed wrong or the attachment was deleted).
  blobNotFound: () =>
    new ApiError(
      404,
      "attachment_not_found",
      undefined,
      undefined,
      "the attachment id is wrong, the attachment was deleted, or it does not belong to the calling agent; run 'pane attachment list' to find the right id",
      false,
      DOCS.api,
    ),

  // Server-side MIME sniff disagreed with the client's declared Content-Type.
  // Closes the "HTML labelled as image/jpeg" attack class — the sniff result
  // is the source of truth and the route refuses the upload here.
  mimeMismatch: (declared: string, sniffed: string) =>
    new ApiError(
      415,
      "mime_mismatch",
      `declared Content-Type '${declared}' does not match the sniffed '${sniffed}'`,
      { declared, sniffed },
      "send a Content-Type that matches the file's actual format; the server validates leading bytes and refuses the upload on mismatch",
      false,
      DOCS.api,
    ),

  // Sniffed MIME isn't in BLOB_MIME_ALLOWLIST. Distinct from mimeMismatch so
  // operators can tell "client lied about Content-Type" from "this format is
  // not accepted by this relay" in the logs.
  mimeDisallowed: (mime: string, allowlist: string[]) =>
    new ApiError(
      415,
      "mime_disallowed",
      `MIME '${mime}' is not in this relay's BLOB_MIME_ALLOWLIST`,
      { mime, allowlist },
      "upload a file matching one of the allowed MIME prefixes; ask the operator to widen BLOB_MIME_ALLOWLIST if a missing prefix is legitimate",
      false,
      DOCS.api,
    ),

  // Per-attachment size cap exceeded. Distinct hint from generic payloadTooLarge so
  // a attachment caller doesn't go hunting for MAX_ARTIFACT_BYTES / MAX_TASTE_BYTES.
  blobSizeExceeded: (maxBytes: number) =>
    new ApiError(
      413,
      "attachment_size_exceeded",
      `attachment exceeds the per-attachment cap of ${maxBytes} bytes`,
      { max_bytes: maxBytes },
      "downscale or compress the attachment to fit; for images, the client SDK does this automatically (max dimension + JPEG quality)",
      false,
      DOCS.api,
    ),

  // A attachment_id baked into an event payload or surface input_data points to
  // a attachment the calling agent can't access (wrong id, wrong owner, or
  // soft-deleted). Surfaces *after* Ajv shape validation has passed but
  // *before* the row hits Prisma — see packages/relay/src/attachments/ref-access.ts
  // for the walker + batch check. 422 because the payload is structurally
  // valid but semantically broken: it references a attachment that does not
  // exist (from this agent's vantage point).
  blobRefNotAccessible: (inaccessibleIds: string[]) =>
    new ApiError(
      422,
      "attachment_ref_not_accessible",
      `attachment ref(s) not accessible: ${inaccessibleIds.join(", ")}`,
      { inaccessible_ids: inaccessibleIds },
      "the payload references one or more attachment ids the calling agent does not own (or that have been deleted); upload the attachment with POST /v1/attachments and use the returned attachment_id, or check 'pane attachment list' for ids you actually own",
      false,
      DOCS.api,
    ),

  // The READ-side counterpart of blobRefNotAccessible. Used by
  // `GET /s/:participantToken/attachments/:attachment_id` (follow-up D of #156): the
  // requested attachment isn't referenced from this surface (or was deleted,
  // or never existed). Same `code` so a single error branch covers both
  // the write-time "ref dangling" surface and the read-time "ref not
  // reachable from your token" surface; 404 here because the resource
  // isn't found from the caller's vantage point — the request itself
  // is structurally fine (vs the 422 write-side path, where the request
  // body was malformed at the ref site).
  blobRefNotAccessibleReadSide: (attachmentId: string) =>
    new ApiError(
      404,
      "attachment_ref_not_accessible",
      `attachment ref not accessible: ${attachmentId}`,
      { attachment_id: attachmentId },
      "the participant token does not have read access to this attachment_id from the current surface; the attachment must be referenced from this surface's events or initial input_data and not be soft-deleted",
      false,
      DOCS.api,
    ),

  // Per-scope aggregate quota exceeded (per-agent, per-surface, or
  // per-template). `scope` carries which one.
  quotaExceeded: (scope: "agent" | "surface" | "template", maxBytes: number) =>
    new ApiError(
      413,
      "quota_exceeded",
      `${scope} attachment quota of ${maxBytes} bytes reached`,
      { scope, max_bytes: maxBytes },
      "delete unused attachments in this scope and retry, or ask the operator to widen the configured quota",
      false,
      DOCS.api,
    ),

  // Returned when an /v1/* request arrives with `x-pane-cli-version` lower
  // than the relay's MIN_CLI_VERSION. The 426 status is the HTTP-spec
  // "Upgrade Required". `details` carries both versions so the CLI can
  // render a precise message; the hint repeats the actionable command in
  // English for callers that don't recognize the code.
  cliUpgradeRequired: (minVersion: string, yourVersion: string) =>
    new ApiError(
      426,
      "cli_upgrade_required",
      `this relay requires @paneui/cli >= ${minVersion} (you sent ${yourVersion})`,
      { min_version: minVersion, your_version: yourVersion },
      `upgrade the @paneui/cli package to >= ${minVersion} and retry; non-CLI library callers can omit the x-pane-cli-version header to opt out of this check`,
      false,
      DOCS.api,
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
