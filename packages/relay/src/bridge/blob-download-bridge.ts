// GET /s/:participantToken/blobs/:blob_id — participant-side blob download.
//
// Follow-up D of #156. Symmetric counterpart to the upload bridge (follow-up
// C). Closes an asymmetry in the agent->iframe story: today, the only way to
// get blob bytes into an iframe is to inline the base64-encoded payload on
// the event itself, because the iframe's CSP is `img-src data: blob:` and
// `connect-src 'none'` (no HTTP). That wastes 33% on base64, duplicates the
// bytes on disk (encrypted blob store + event row), and replays on every WS
// reconnect — defeating the whole point of blob storage. With this route +
// `window.pane.downloadBlob()` the agent sends just a BlobRef on the event,
// the iframe lazy-fetches the bytes through the shell, and renders them via
// `URL.createObjectURL(blob)`.
//
// Trust model:
//   * Auth is the participant token in the path — exactly the bearer used
//     by every other `/s/:token/*` route (and by the upload bridge). No
//     second credential. Same opaque error as upload on a bad token
//     (`participant_token_invalid`) to prevent enumeration.
//   * Authz is "the requested blob_id must be REFERENCED FROM THIS SESSION."
//     A participant can only download blobs the owning agent has explicitly
//     referenced in the session — either in the session's initial
//     `inputData` (validated against the artifact version's `inputSchema`)
//     or in any event in the session (validated against the session's
//     `eventSchema`). Cross-session probing returns 404, never 403 — an
//     attacker probing must not be able to distinguish "blob exists, but
//     not in your session" from "blob does not exist at all."
//   * Defense in depth after the ref check: the blob row's owning agent
//     must match the session's owning agent and the row must not be soft-
//     deleted. The ref walker's set should already be agent-scoped (PR
//     #164 only collects refs Ajv validated, and Ajv only let through
//     blob_ids that passed agent-access at write time), but belt-and-
//     braces against schema/walker bugs.
//
// Pipeline: identical decrypt path to the agent-side `GET /v1/blobs/:id`
// in src/http/routes/blobs.ts. Match it. If `BLOB_ENCRYPT_AT_REST=false`
// the decrypt branch is a no-op and the stream passes through.
//
// Performance note: this implementation walks events on every request. The
// in-flight cost is one extra Prisma query per request and one schema walk
// per event — bounded by `MAX_EVENTS_PER_SESSION` and the per-event
// payload size cap. For v0.1.0 that's acceptable; if profiling shows a
// hotspot we can materialise referenced blob_ids into a `SessionBlobRef`
// join table at write time (the only place refs are introduced into a
// session is the writeEvent + session-create paths, both already running
// the same walker — see core/events.ts and ref-access.ts). Not in scope
// for this PR.

import { Hono } from "hono";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import { hashKey } from "../keys.js";
import { errors } from "../http/errors.js";
import type { AppEnv } from "../http/env.js";
import { collectBlobRefs } from "../blobs/ref-access.js";
import type { EventSchema } from "../types.js";

// Participant tokens are minted in keys.ts with a type prefix ("tok_a_" for
// agent participants, "tok_h_" for humans) + `randomBytes(32).toString("base64url")`.
// Reject on shape before we hash so pathological inputs (huge strings,
// control chars) can't force SHA-256 work + a guaranteed-miss DB lookup. The
// same guard pattern lives in src/bridge/routes.ts and blob-upload-bridge.ts.
const PARTICIPANT_TOKEN_RX = /^tok_[ah]_[A-Za-z0-9_-]{43}$/;

// Blob ids are cuid-shaped — defined by the `format: pane-blob-id` Ajv
// format registered in core/validation.ts (Phase D of #156). The regex
// here is purely a shape gate to reject pathological inputs before we
// touch the DB; the real semantic check is the reference-set membership
// below.
const BLOB_ID_RX = /^[a-z0-9]{20,40}$/i;

const blobDownloadBridge = new Hono<AppEnv>();

// GET /s/:participantToken/blobs/:blob_id
//
// Response body: decrypted bytes (when BLOB_ENCRYPT_AT_REST is on) or
// raw stored bytes (when off).
//
// Response headers (all hardened):
//   Content-Type: <blob.mime>          — server-side sniffed at upload time
//   Content-Length: <blob.size>        — plaintext size, stored on the row
//   X-Content-Type-Options: nosniff    — defeat browser sniffing
//   Cache-Control: private, no-store   — never cache participant-token-authed bytes
//   Referrer-Policy: no-referrer       — token in path; don't leak via referer
//   Cross-Origin-Resource-Policy: same-origin
//
// Errors:
//   401 participant_token_invalid — token malformed / unknown / revoked / session gone
//   400 invalid_request           — blob_id of malformed shape
//   404 blob_ref_not_accessible   — blob_id not referenced from this session
//   410 gone                      — session closed/expired
blobDownloadBridge.get("/:participantToken/blobs/:blob_id", async (c) => {
  const prisma = c.get("prisma");
  const store = c.get("blobStore");
  const token = c.req.param("participantToken");
  const blobId = c.req.param("blob_id");

  if (!store) {
    throw errors.invalidRequest(
      "blob storage is not configured on this relay",
      undefined,
      "the operator has not configured a BlobStore; ask them to set BLOB_STORE=filesystem or BLOB_STORE=azure and restart the relay",
    );
  }

  // Shape gates first — save SHA + DB lookups on path-spam. Token check
  // mirrors loadByToken in routes.ts and the upload bridge.
  if (!PARTICIPANT_TOKEN_RX.test(token)) {
    throw errors.participantTokenInvalid();
  }
  if (!BLOB_ID_RX.test(blobId)) {
    // 400 is the right surface for a malformed path parameter — distinct
    // from "valid shape, not accessible from this session" which is 404.
    throw errors.invalidRequest(
      "malformed blob_id",
      undefined,
      "blob_id must match the relay's pane-blob-id format (cuid-shaped string)",
    );
  }

  // Resolve participant -> session -> agent. Identical to the upload bridge.
  const participant = await prisma.participant.findUnique({
    where: { tokenHash: hashKey(token) },
    select: { sessionId: true, revokedAt: true },
  });
  if (!participant || participant.revokedAt) {
    throw errors.participantTokenInvalid();
  }
  const session = await prisma.session.findUnique({
    where: { id: participant.sessionId },
    select: {
      id: true,
      agentId: true,
      status: true,
      expiresAt: true,
      inputData: true,
      artifactVersion: {
        select: { eventSchema: true, inputSchema: true },
      },
    },
  });
  if (!session) {
    throw errors.participantTokenInvalid();
  }
  if (session.status !== "open" || session.expiresAt.getTime() < Date.now()) {
    // Same 410 the upload bridge returns when an event-emit lands on a
    // closed session.
    throw errors.gone("session is closed");
  }

  // Authz: a blob is accessible to a participant of THIS session if EITHER
  //   (a) the blob is referenced from this session's inputData or events —
  //       i.e. the agent put it on the wire here (PR #164's walker; same
  //       check the write side uses), OR
  //   (b) the blob is scope=session AND its sessionId matches this session.
  //
  // Branch (b) is needed because:
  //   - participant uploads (POST /s/:tok/blobs, PR #165) pin scope=session
  //     and sessionId=session.id at write time. Without (b), the participant
  //     who JUST uploaded a blob can't read it back until they emit an
  //     event referencing the blob_id — which makes the obvious "upload an
  //     image and immediately preview it" UX broken for no good reason.
  //   - agent-uploaded session-scoped blobs (scope=session, sessionId set
  //     when the agent uploads) are by construction part of this session's
  //     surface even if no event references them yet.
  //
  // Branch (b) does NOT loosen the model — session-scope means session-
  // scope. agent-scope / artifact-scope blobs still need branch (a) to be
  // reachable, which means the agent has to explicitly surface them via
  // events / inputData.
  const row = await prisma.blob.findUnique({ where: { id: blobId } });

  let accessible = false;
  if (row && row.scope === "session" && row.sessionId === session.id) {
    accessible = true;
  } else {
    const referenced = await collectSessionBlobRefs(prisma, session);
    if (referenced.has(blobId)) accessible = true;
  }

  if (!accessible) {
    // Opaque 404 — never reveal whether the id exists but lives in another
    // session vs. doesn't exist at all. Reusing PR #164's
    // `blob_ref_not_accessible` code keeps the surface consistent.
    throw errors.blobRefNotAccessibleReadSide(blobId);
  }

  // Defense in depth — the walker's set should already only contain blobs
  // the agent can reach, but a schema/walker bug must not become a
  // cross-tenant leak. Verify the row exists, is owned by THIS session's
  // agent, is `ready`, and not soft-deleted.
  if (
    !row ||
    row.ownerId !== session.agentId ||
    row.status === "deleted" ||
    row.deletedAt !== null
  ) {
    // Collapse defense-in-depth failures into the same 404 — never
    // distinguish "ref valid but blob gone" from "ref invalid."
    throw errors.blobRefNotAccessibleReadSide(blobId);
  }
  if (row.status !== "ready") {
    // pending / failed — exists but not downloadable. Same surface as
    // the agent route to keep the two consistent.
    throw errors.blobRefNotAccessibleReadSide(blobId);
  }

  // Stream from the backend. Identical decrypt path to GET /v1/blobs/:id
  // in src/http/routes/blobs.ts — match it exactly so the two routes can't
  // drift on encryption-at-rest semantics. (Per security review: the
  // existing /b/<token> route has a known bug where the capability URL
  // serves raw ciphertext instead of decrypting; that is tracked
  // separately and NOT fixed here. This route must always decrypt.)
  const stream = await store.get(row.storageKey);
  if (!stream) {
    // Metadata says ready, storage says missing — same recovery as the
    // agent route: mark the row failed and 404.
    await prisma.blob.update({
      where: { id: row.id },
      data: { status: "failed" },
    });
    throw errors.blobRefNotAccessibleReadSide(blobId);
  }

  let outputStream: Readable = stream;
  if (row.encryptionEnvelope) {
    const { decryptBlob, parseEnvelope } = await import("../blobs/encrypt.js");
    const { getMasterKey } = await import("../crypto.js");
    const envelope = parseEnvelope(row.encryptionEnvelope);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const ciphertext = Buffer.concat(chunks);
    const plaintext = decryptBlob(ciphertext, envelope, getMasterKey());
    outputStream = Readable.from(plaintext);
  }

  // Response headers — see route doc comment above. Content-Length is
  // PLAINTEXT size; row.size is the plaintext size regardless of
  // encryption (the encrypt path stores size before encrypting).
  c.header("Content-Type", row.mime);
  c.header("Content-Length", String(row.size));
  c.header("X-Content-Type-Options", "nosniff");
  // Participant-token-authed bytes must never be cached by intermediaries
  // — the URL contains the credential. `private` blocks shared caches,
  // `no-store` blocks the browser cache too.
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cross-Origin-Resource-Policy", "same-origin");

  // Hono accepts a Web ReadableStream as the body; convert.
  return c.body(Readable.toWeb(outputStream) as unknown as ReadableStream);
});

// ---------------------------------------------------------------------------
// Collect every blob_id referenced from a session — either in its initial
// `inputData` (walked against the artifact version's `inputSchema`) or in
// any event's `data` (walked against the event-type's payload schema from
// the session's `eventSchema`).
//
// Pure read; no mutation. The walker is `collectBlobRefs` from PR #164.
// ---------------------------------------------------------------------------
type SessionForRefs = {
  id: string;
  inputData: unknown;
  artifactVersion: {
    eventSchema: unknown;
    inputSchema: unknown;
  };
};

async function collectSessionBlobRefs(
  prisma: PrismaClient,
  session: SessionForRefs,
): Promise<Set<string>> {
  const acc = new Set<string>();

  // 1) inputData against inputSchema (when both exist).
  const inputSchema = session.artifactVersion.inputSchema as object | null;
  if (inputSchema && session.inputData !== null) {
    for (const id of collectBlobRefs(inputSchema, session.inputData)) {
      acc.add(id);
    }
  }

  // 2) events: walk each one against the type's payload schema.
  const eventSchema = session.artifactVersion
    .eventSchema as unknown as EventSchema | null;
  if (!eventSchema) return acc;

  // We only care about events whose schema declares a blob ref. The walker
  // returns [] cheaply for schemas with no `format: pane-blob-id` site, so
  // we can just walk every event; but loading EVERY event row's `data`
  // (which can be 64 KB each up to MAX_EVENT_DATA_BYTES) per request is the
  // cost we want to keep an eye on. The cap is `MAX_EVENTS_PER_SESSION`
  // (5000 default) × MAX_EVENT_DATA_BYTES (64 KB) = ~320 MB worst case.
  // In practice it's tiny. If profiling shows this hotspot we materialise.
  const events = await prisma.event.findMany({
    where: { sessionId: session.id },
    select: { type: true, data: true },
  });
  for (const ev of events) {
    const entry = eventSchema.events?.[ev.type];
    if (!entry) continue;
    for (const id of collectBlobRefs(entry.payload, ev.data)) {
      acc.add(id);
    }
  }

  return acc;
}

export default blobDownloadBridge;
