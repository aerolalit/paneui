// POST /s/:participantToken/attachments — human-side attachment upload.
//
// Follow-up C of #156. The agent-side already has `POST /v1/attachments` (multipart)
// and `POST /v1/attachments/presign` (direct-to-storage), but the human inside the
// rendered pane had no way to upload a file BACK to the relay. This closes
// the loop: the iframe runtime exposes `window.pane.uploadBlob(file)`, the shell
// brokers a fetch to this route using the participant token it already has
// (the same token it uses for `/s/:token/presence` and the WS ticket mint),
// and the route returns a `AttachmentRef` that the template can then attach to a
// `pane.emit(...)` event.
//
// Trust model:
//   * Auth is the participant token in the path — exactly the bearer used
//     by every other `/s/:token/*` route. No second credential. The route
//     is rate-limited by the general /s/* limiter mounted in app.ts.
//   * The token reveals the surface; the surface reveals the owning agent.
//     The participant is NOT the attachment owner. The owning agent
//     (surface.agentId) is recorded on the Blob row, and the agent's
//     aggregate quota (MAX_BLOBS_PER_AGENT_BYTES) gates the upload — human
//     uploads count against the agent's footprint.
//   * Scope is FORCED to `surface`. Even if multipart carries
//     `scope=agent|template`, this route ignores it: a human cannot mint
//     long-lived agent-scope attachments through their participant token, and
//     cannot reach into an template they don't own. Surface-scope attachments
//     cascade-delete with the surface, which bounds the blast radius of a
//     leaked participant token (issue #155 threat-model).
//
// Pipeline: identical to `POST /v1/attachments` (MIME sniff, polyglot defense,
// EXIF strip, encryption-at-rest, quota, scan webhook) — shared via
// `processBlobUpload` in attachments/upload-pipeline.ts so the two routes can't
// drift on security-sensitive details.

import { Hono } from "hono";
import { hashKey } from "../keys.js";
import { errors } from "../http/errors.js";
import type { AppEnv } from "../http/env.js";
import { processBlobUpload } from "../attachments/index.js";
import { makeQuotaEnforcer } from "../http/routes/attachments.js";

// Participant tokens are minted in keys.ts with a type prefix ("tok_a_" for
// agent participants, "tok_h_" for humans) + `randomBytes(32).toString("base64url")`.
// Reject on shape before we hash so pathological inputs (huge strings,
// control chars) can't force SHA-256 work + a guaranteed-miss DB lookup. The
// same guard pattern lives in src/bridge/routes.ts for the GET surface.
const PARTICIPANT_TOKEN_RX = /^tok_[ah]_[A-Za-z0-9_-]{43}$/;

const blobUploadBridge = new Hono<AppEnv>();

// POST /s/:participantToken/attachments
//
// Multipart body:
//   file       — required. The single binary file part.
//   filename   — optional UX-only display name.
//
// `scope`, `surface_id`, `template_id` — IGNORED. Scope is pinned to
// `surface` and the surface id is derived from the participant token.
//
// Response: serialised Blob row (the same shape `POST /v1/attachments` returns).
// Errors: surfaced as the `{error: {code, message, hint, retryable, docs_url}}`
// envelope used everywhere else.
blobUploadBridge.post("/:participantToken/attachments", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const store = c.get("blobStore");
  const token = c.req.param("participantToken");

  if (!store) {
    throw errors.invalidRequest(
      "attachment storage is not configured on this relay",
      undefined,
      "the operator has not configured a AttachmentStore; ask them to set BLOB_STORE=filesystem or BLOB_STORE=azure and restart the relay",
    );
  }

  // Shape check first — saves a SHA + DB hit on path-spam. The same regex
  // gate lives in `loadByToken` in src/bridge/routes.ts (the GET surface).
  if (!PARTICIPANT_TOKEN_RX.test(token)) {
    throw errors.participantTokenInvalid();
  }

  // Resolve participant → surface → agent. A revoked participant or a
  // missing surface both collapse to participant_token_invalid: a participant
  // poking at uploads has no business knowing which of the two it is, and
  // the surface matches the GET routes' "not_found-on-bad-token" behaviour.
  const participant = await prisma.participant.findUnique({
    where: { tokenHash: hashKey(token) },
    select: { surfaceId: true, revokedAt: true },
  });
  if (!participant || participant.revokedAt) {
    throw errors.participantTokenInvalid();
  }
  const surface = await prisma.surface.findUnique({
    where: { id: participant.surfaceId },
    select: { id: true, agentId: true, status: true, expiresAt: true },
  });
  if (!surface) {
    throw errors.participantTokenInvalid();
  }
  if (surface.status !== "open" || surface.expiresAt.getTime() < Date.now()) {
    // Same 410 the agent surface returns when an event-emit lands on a
    // closed surface — a closed pane shouldn't accept new attachments either.
    throw errors.gone("surface is closed");
  }

  // Multipart parse. Hono's parseBody is the same primitive POST /v1/attachments
  // uses, so the two routes share the same envelope expectations + error
  // surface for malformed bodies.
  const form = await c.req.parseBody({ all: false });
  const file = form.file;
  if (!(file instanceof File)) {
    throw errors.invalidRequest(
      "missing 'file' part in multipart body",
      undefined,
      "POST a multipart/form-data body with a 'file' field carrying the binary upload",
    );
  }

  // Forced surface scope. Even if the multipart carries scope/surface_id/
  // template_id, we IGNORE them — the surface id comes from the token, and
  // a human cannot pivot to agent- or template-scope attachments through this
  // route.
  const final = await processBlobUpload(
    {
      prisma,
      config,
      store,
      quota: makeQuotaEnforcer(prisma, config, store),
    },
    {
      // Owner = the agent that owns the surface. The participant is NOT
      // the owner; human uploads count against the agent's aggregate quota.
      ownerId: surface.agentId,
      scope: "surface",
      surfaceId: surface.id,
      templateId: null,
      filename: typeof form.filename === "string" ? form.filename : null,
      file,
    },
  );

  return c.json(serialize(final), 201);
});

interface SerializedBlob {
  attachment_id: string;
  scope: "agent" | "surface" | "template";
  mime: string;
  size: number;
  sha256: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  status: string;
  surface_id: string | null;
  template_id: string | null;
  created_at: string;
  confirmed_at: string | null;
  deleted_at: string | null;
}

function serialize(row: {
  id: string;
  scope: string;
  mime: string;
  size: number;
  sha256: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  status: string;
  surfaceId: string | null;
  templateId: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  deletedAt: Date | null;
}): SerializedBlob {
  return {
    attachment_id: row.id,
    scope: row.scope as "agent" | "surface" | "template",
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    filename: row.filename,
    width: row.width,
    height: row.height,
    status: row.status,
    surface_id: row.surfaceId,
    template_id: row.templateId,
    created_at: row.createdAt.toISOString(),
    confirmed_at: row.confirmedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

export default blobUploadBridge;
