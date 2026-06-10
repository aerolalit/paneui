// GET /s/:participantToken/attachments/:attachment_id — participant-side attachment download.
//
// Follow-up D of #156. Symmetric counterpart to the upload bridge (follow-up
// C). Closes an asymmetry in the agent->iframe story: inlining the
// base64-encoded payload on the event itself wastes 33% on base64, duplicates
// the bytes on disk (encrypted attachment store + event row), and replays on
// every WS reconnect — defeating the whole point of attachment storage. With
// this route + `window.pane.downloadBlob()` the agent sends just an
// AttachmentRef on the event, the iframe lazy-fetches the bytes through the
// shell, and renders them via `URL.createObjectURL(attachment)`. (The iframe
// CSP also allows the relay origin in `img-src`/`media-src` — see buildPaneCsp
// — so a template can alternatively render bytes straight from a `/b/<token>`
// capability URL; `connect-src 'none'` still blocks fetch/XHR.)
//
// Trust model:
//   * Auth is the participant token in the path — exactly the bearer used
//     by every other `/s/:token/*` route (and by the upload bridge). No
//     second credential. Same opaque error as upload on a bad token
//     (`participant_token_invalid`) to prevent enumeration.
//   * Authz is "the requested attachment_id must be REFERENCED FROM THIS PANE."
//     A participant can only download attachments the owning agent has explicitly
//     referenced in the pane — either in the pane's initial
//     `inputData` (validated against the template version's `inputSchema`)
//     or in any event in the pane (validated against the pane's
//     `eventSchema`). Cross-pane probing returns 404, never 403 — an
//     attacker probing must not be able to distinguish "attachment exists, but
//     not in your pane" from "attachment does not exist at all."
//   * Defense in depth after the ref check: the attachment row's owning agent
//     must match the pane's owning agent and the row must not be soft-
//     deleted. The ref walker's set should already be agent-scoped (PR
//     #164 only collects refs Ajv validated, and Ajv only let through
//     attachment_ids that passed agent-access at write time), but belt-and-
//     braces against schema/walker bugs.
//
// Pipeline: identical decrypt path to the agent-side `GET /v1/attachments/:id`
// in src/http/routes/attachments.ts. Match it. If `BLOB_ENCRYPT_AT_REST=false`
// the decrypt branch is a no-op and the stream passes through.
//
// Performance note: this implementation walks events on every request. The
// in-flight cost is one extra Prisma query per request and one schema walk
// per event — bounded by `MAX_EVENTS_PER_PANE` and the per-event
// payload size cap. For v0.1.0 that's acceptable; if profiling shows a
// hotspot we can materialise referenced attachment_ids into a `PaneBlobRef`
// join table at write time (the only place refs are introduced into a
// pane is the writeEvent + pane-create paths, both already running
// the same walker — see core/events.ts and ref-access.ts). Not in scope
// for this PR.

import { Hono } from "hono";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import { hashKey } from "../keys.js";
import { errors } from "../http/errors.js";
import type { AppEnv } from "../http/env.js";
import { collectBlobRefs } from "../attachments/ref-access.js";
import { setAttachmentDownloadHeaders } from "../attachments/index.js";
import { participantBindingSatisfied } from "../auth/human-auth.js";
import type { EventSchema } from "../types.js";

// Participant tokens are minted in keys.ts with a type prefix ("tok_a_" for
// agent participants, "tok_h_" for humans) + `randomBytes(32).toString("base64url")`.
// Reject on shape before we hash so pathological inputs (huge strings,
// control chars) can't force SHA-256 work + a guaranteed-miss DB lookup. The
// same guard pattern lives in src/bridge/routes.ts and attachment-upload-bridge.ts.
const PARTICIPANT_TOKEN_RX = /^tok_[ah]_[A-Za-z0-9_-]{43}$/;

// Blob ids are cuid-shaped — defined by the `format: pane-attachment-id` Ajv
// format registered in core/validation.ts (Phase D of #156). The regex
// here is purely a shape gate to reject pathological inputs before we
// touch the DB; the real semantic check is the reference-set membership
// below.
const BLOB_ID_RX = /^[a-z0-9]{20,40}$/i;

const blobDownloadBridge = new Hono<AppEnv>();

// GET /s/:participantToken/attachments/:attachment_id
//
// Response body: decrypted bytes (when BLOB_ENCRYPT_AT_REST is on) or
// raw stored bytes (when off).
//
// Response headers (all hardened):
//   Content-Type: <attachment.mime>          — server-side sniffed at upload time
//   Content-Length: <attachment.size>        — plaintext size, stored on the row
//   X-Content-Type-Options: nosniff    — defeat browser sniffing
//   Cache-Control: private, no-store   — never cache participant-token-authed bytes
//   Referrer-Policy: no-referrer       — token in path; don't leak via referer
//   Cross-Origin-Resource-Policy: same-origin
//
// Errors:
//   401 participant_token_invalid — token malformed / unknown / revoked / pane gone
//   400 invalid_request           — attachment_id of malformed shape
//   404 attachment_ref_not_accessible   — attachment_id not referenced from this pane
//   410 gone                      — pane closed/expired
blobDownloadBridge.get(
  "/:participantToken/attachments/:attachment_id",
  async (c) => {
    const prisma = c.get("prisma");
    const store = c.get("blobStore");
    const token = c.req.param("participantToken");
    const attachmentId = c.req.param("attachment_id");

    if (!store) {
      throw errors.invalidRequest(
        "attachment storage is not configured on this relay",
        undefined,
        "the operator has not configured a AttachmentStore; ask them to set BLOB_STORE=filesystem or BLOB_STORE=azure and restart the relay",
      );
    }

    // Shape gates first — save SHA + DB lookups on path-spam. Token check
    // mirrors loadByToken in routes.ts and the upload bridge.
    if (!PARTICIPANT_TOKEN_RX.test(token)) {
      throw errors.participantTokenInvalid();
    }
    if (!BLOB_ID_RX.test(attachmentId)) {
      // 400 is the right pane for a malformed path parameter — distinct
      // from "valid shape, not accessible from this pane" which is 404.
      throw errors.invalidRequest(
        "malformed attachment_id",
        undefined,
        "attachment_id must match the relay's pane-attachment-id format (cuid-shaped string)",
      );
    }

    // Resolve participant -> pane -> agent. Identical to the upload bridge.
    const participant = await prisma.participant.findUnique({
      where: { tokenHash: hashKey(token) },
      select: { paneId: true, revokedAt: true, humanId: true },
    });
    if (!participant || participant.revokedAt) {
      throw errors.participantTokenInvalid();
    }
    // F-02: an identity-bound token only works with the matching login cookie.
    // A miss collapses to the same opaque participant_token_invalid this route
    // returns for a bad/revoked token — no "wrong account" oracle on the bytes.
    if (
      !(await participantBindingSatisfied(
        prisma,
        participant,
        c.req.header("cookie") ?? null,
      ))
    ) {
      throw errors.participantTokenInvalid();
    }
    const pane = await prisma.pane.findUnique({
      where: { id: participant.paneId },
      select: {
        id: true,
        agentId: true,
        status: true,
        expiresAt: true,
        inputData: true,
        templateVersion: {
          select: {
            eventSchema: true,
            inputSchema: true,
            // #505 (B): records may carry attachment refs too. The walker
            // needs each collection's row schema to resolve a record-only ref.
            recordSchema: true,
          },
        },
      },
    });
    if (!pane) {
      throw errors.participantTokenInvalid();
    }
    if (pane.status !== "open" || pane.expiresAt.getTime() < Date.now()) {
      // Same 410 the upload bridge returns when an event-emit lands on a
      // closed pane.
      throw errors.gone("pane is closed");
    }

    // Authz: a attachment is accessible to a participant of THIS pane if EITHER
    //   (a) the attachment is referenced from this pane's inputData or events —
    //       i.e. the agent put it on the wire here (PR #164's walker; same
    //       check the write side uses), OR
    //   (b) the attachment is scope=pane AND its paneId matches this pane.
    //
    // Branch (b) is needed because:
    //   - participant uploads (POST /s/:tok/attachments, PR #165) pin scope=pane
    //     and paneId=pane.id at write time. Without (b), the participant
    //     who JUST uploaded a attachment can't read it back until they emit an
    //     event referencing the attachment_id — which makes the obvious "upload an
    //     image and immediately preview it" UX broken for no good reason.
    //   - agent-uploaded pane-scoped attachments (scope=pane, paneId set
    //     when the agent uploads) are by construction part of this pane's
    //     pane even if no event references them yet.
    //
    // Branch (b) does NOT loosen the model — pane-scope means pane-
    // scope. agent-scope / template-scope attachments still need branch (a) to be
    // reachable, which means the agent has to explicitly pane them via
    // events / inputData.
    const row = await prisma.attachment.findUnique({
      where: { id: attachmentId },
    });

    let accessible = false;
    if (row && row.scope === "pane" && row.paneId === pane.id) {
      accessible = true;
    } else {
      const referenced = await collectSessionBlobRefs(prisma, pane);
      if (referenced.has(attachmentId)) accessible = true;
    }

    if (!accessible) {
      // Opaque 404 — never reveal whether the id exists but lives in another
      // pane vs. doesn't exist at all. Reusing PR #164's
      // `attachment_ref_not_accessible` code keeps the pane consistent.
      throw errors.blobRefNotAccessibleReadSide(attachmentId);
    }

    // Defense in depth — the walker's set should already only contain attachments
    // the agent can reach, but a schema/walker bug must not become a
    // cross-tenant leak. Verify the row exists, is owned by THIS pane's
    // agent, is `ready`, and not soft-deleted.
    if (
      !row ||
      row.ownerId !== pane.agentId ||
      row.status === "deleted" ||
      row.deletedAt !== null
    ) {
      // Collapse defense-in-depth failures into the same 404 — never
      // distinguish "ref valid but attachment gone" from "ref invalid."
      throw errors.blobRefNotAccessibleReadSide(attachmentId);
    }
    if (row.status !== "ready") {
      // pending / failed — exists but not downloadable. Same pane as
      // the agent route to keep the two consistent.
      throw errors.blobRefNotAccessibleReadSide(attachmentId);
    }

    // Stream from the backend. Identical decrypt path to GET /v1/attachments/:id
    // in src/http/routes/attachments.ts AND the capability-URL route in
    // src/bridge/attachment-bridge.ts — all three share the same
    // encrypt.parseEnvelope + decryptBlob calls so they cannot drift on
    // encryption-at-rest semantics.
    const stream = await store.get(row.storageKey);
    if (!stream) {
      // Metadata says ready, storage says missing — same recovery as the
      // agent route: mark the row failed and 404.
      await prisma.attachment.update({
        where: { id: row.id },
        data: { status: "failed" },
      });
      throw errors.blobRefNotAccessibleReadSide(attachmentId);
    }

    let outputStream: Readable = stream;
    if (row.encryptionEnvelope) {
      const { decryptBlob, parseEnvelope } =
        await import("../attachments/encrypt.js");
      const { getMasterKey } = await import("../crypto.js");
      const envelope = parseEnvelope(row.encryptionEnvelope);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const ciphertext = Buffer.concat(chunks);
      const plaintext = decryptBlob(ciphertext, envelope, getMasterKey());
      outputStream = Readable.from(plaintext);
    }

    // Response headers — see route doc comment above. Centralised in
    // setAttachmentDownloadHeaders so this participant path shares the exact
    // posture of the agent + capability-URL paths: nosniff, raster-only inline
    // disposition (svg/everything-else → attachment, previously this route set
    // no disposition at all and the browser was free to render inline),
    // no-store (the participant token in the URL is the credential — never
    // cache), same-origin CORP, no-referrer, and the framing defences (CSP
    // `default-src 'none'; sandbox; frame-ancestors 'none'` + X-Frame-Options:
    // DENY). Content-Length is the PLAINTEXT size; row.size is the plaintext
    // size regardless of encryption.
    setAttachmentDownloadHeaders(c, { mime: row.mime, size: row.size });

    // Hono accepts a Web ReadableStream as the body; convert.
    return c.body(Readable.toWeb(outputStream) as unknown as ReadableStream);
  },
);

// ---------------------------------------------------------------------------
// Collect every attachment_id referenced from a pane — in its initial
// `inputData` (walked against the template version's `inputSchema`), in any
// event's `data` (walked against the event-type's payload schema from the
// pane's `eventSchema`), OR in any of the pane's records (walked against the
// owning collection's row schema from the pane's `recordSchema`, #505 B).
//
// Pure read; no mutation. The walker is `collectBlobRefs` from PR #164.
// ---------------------------------------------------------------------------
type PaneForRefs = {
  id: string;
  inputData: unknown;
  templateVersion: {
    eventSchema: unknown;
    inputSchema: unknown;
    recordSchema?: unknown;
  };
};

async function collectSessionBlobRefs(
  prisma: PrismaClient,
  pane: PaneForRefs,
): Promise<Set<string>> {
  const acc = new Set<string>();

  // 1) inputData against inputSchema (when both exist).
  const inputSchema = pane.templateVersion.inputSchema as object | null;
  if (inputSchema && pane.inputData !== null) {
    for (const id of collectBlobRefs(inputSchema, pane.inputData)) {
      acc.add(id);
    }
  }

  // 2) records: walk each record's data against its collection's row schema.
  //    Without this step (#505 B) an attachment the agent legitimately owns and
  //    references ONLY from a record can never be served via downloadBlob() —
  //    it 404s as attachment_ref_not_accessible even though the agent owns it.
  //    The defense-in-depth owner check downstream (row.ownerId === pane.agentId)
  //    still guards the bytes, so adding refs here only un-breaks legitimate
  //    own-attachment reads; it cannot expose another agent's attachment.
  await collectRecordBlobRefs(prisma, pane, acc);

  // 3) events: walk each one against the type's payload schema.
  const eventSchema = pane.templateVersion
    .eventSchema as unknown as EventSchema | null;
  if (!eventSchema) return acc;

  // We only care about events whose schema declares a attachment ref. The walker
  // returns [] cheaply for schemas with no `format: pane-attachment-id` site, so
  // we can just walk every event; but loading EVERY event row's `data`
  // (which can be 64 KB each up to MAX_EVENT_DATA_BYTES) per request is the
  // cost we want to keep an eye on. The cap is `MAX_EVENTS_PER_PANE`
  // (5000 default) × MAX_EVENT_DATA_BYTES (64 KB) = ~320 MB worst case.
  // In practice it's tiny. If profiling shows this hotspot we materialise.
  const events = await prisma.event.findMany({
    where: { paneId: pane.id },
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

// Walk the pane's records against their collection row-schemas, adding any
// `format: pane-attachment-id` refs to `acc`. Mirrors the events walk above but
// keyed on the recordSchema's `x-pane-collections[name].schema.$ref` → `$defs`
// row schema. Skips silently when the pane declares no record collections.
async function collectRecordBlobRefs(
  prisma: PrismaClient,
  pane: PaneForRefs,
  acc: Set<string>,
): Promise<void> {
  const rowSchemasByCollection = resolveRecordRowSchemas(
    pane.templateVersion.recordSchema,
  );
  // No record collections declared (or recordSchema is null/malformed) → no
  // record refs possible. Avoid the DB round-trip entirely.
  if (rowSchemasByCollection.size === 0) return;

  // Pull live + tombstoned record rows for this pane with their collection
  // name. Tombstones are included for symmetry with the write-side gate (a
  // soft-deleted record's ref shouldn't suddenly become un-downloadable mid-
  // tombstone-window), and the downstream owner/status checks still gate bytes.
  const records = await prisma.paneRecord.findMany({
    where: { collection: { paneId: pane.id } },
    select: { data: true, collection: { select: { name: true } } },
  });
  for (const rec of records) {
    const rowSchema = rowSchemasByCollection.get(rec.collection.name);
    if (!rowSchema) continue;
    for (const id of collectBlobRefs(rowSchema, rec.data)) acc.add(id);
  }
}

// Resolve a pane's recordSchema document into a map of
// collectionName → dereferenced row schema. Mirrors resolveCollection in
// core/records.ts but builds the whole map at once (the read path walks every
// collection, not one named collection) and never throws — a malformed or
// absent schema simply yields an empty map (read side fails closed: no refs).
function resolveRecordRowSchemas(recordSchema: unknown): Map<string, object> {
  const out = new Map<string, object>();
  if (!recordSchema || typeof recordSchema !== "object") return out;
  const doc = recordSchema as Record<string, unknown>;
  const xpc = doc["x-pane-collections"];
  if (!xpc || typeof xpc !== "object") return out;
  const defs = doc["$defs"] as Record<string, unknown> | undefined;
  for (const [name, entryRaw] of Object.entries(
    xpc as Record<string, unknown>,
  )) {
    if (!entryRaw || typeof entryRaw !== "object") continue;
    const schemaField = (entryRaw as Record<string, unknown>)["schema"] as
      | { $ref?: string }
      | undefined;
    const refRaw = schemaField?.$ref;
    if (typeof refRaw !== "string") continue;
    const refMatch = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(refRaw);
    const defName = refMatch?.[1];
    const rowSchema = defName ? defs?.[defName] : undefined;
    if (
      rowSchema &&
      typeof rowSchema === "object" &&
      !Array.isArray(rowSchema)
    ) {
      out.set(name, rowSchema as object);
    }
  }
  return out;
}

export default blobDownloadBridge;
