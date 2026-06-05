// /v1/attachments — binary attachments owned by an agent.
//
// Endpoints in this module:
//   GET    /v1/attachments                          agent-auth list (paginated)
//   POST   /v1/attachments                          multipart upload, three scopes
//   GET    /v1/attachments/:id                      agent-auth download
//   GET    /v1/attachments/:id/metadata             agent-auth metadata-only (JSON AttachmentRef)
//   DELETE /v1/attachments/:id                      soft-delete (idempotent)
//   GET    /v1/attachments/:id/tokens               agent-auth list capability tokens (audit)
//   POST   /v1/attachments/:id/tokens               mint a /b/<token> capability URL
//   DELETE /v1/attachments/:id/tokens/:token_id     revoke a token
//
// The /b/<token> fetch path itself lives in src/bridge/attachment-bridge.ts so the
// no-auth pane is clearly separated from the agent-auth one here.
//
// Out of scope for the foundation stack — landing in later PRs against
// feat/attachments:
//   * AzureBlobStore + POST /v1/attachments/presign direct-to-storage path
//   * pane.uploadBlob() in @paneui/core + pane attachment * subcommands in CLI
//   * polyglot defense + EXIF strip via sharp
//   * envelope encryption-at-rest, scan hook, LRU eviction, audit-history
//
// Every upload runs through server-side magic-byte MIME sniffing
// (mime-sniff.ts) — the client's Content-Type is never trusted. Sniff
// mismatch → 415 mime_mismatch. Disallowed MIME → 415 mime_disallowed.
// Size exceeding MAX_BLOB_BYTES → 413 attachment_size_exceeded.

import { Hono } from "hono";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../../config.js";
import { requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import {
  AttachmentIntegrityError,
  generateBlobToken,
  isMimeAllowed,
  processBlobUpload,
  setAttachmentDownloadHeaders,
  storageKeyFor,
  type AttachmentStore,
  type QuotaEnforcer,
} from "../../attachments/index.js";

const attachments = new Hono<AuthEnv>();
attachments.use("*", requireAgent);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SerializedBlob {
  attachment_id: string;
  scope: "agent" | "pane" | "template";
  mime: string;
  size: number;
  sha256: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  status: string;
  pane_id: string | null;
  template_id: string | null;
  created_at: string;
  confirmed_at: string | null;
  deleted_at: string | null;
}

interface AttachmentRow {
  id: string;
  scope: string;
  mime: string;
  size: number;
  sha256: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  status: string;
  paneId: string | null;
  templateId: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  deletedAt: Date | null;
}

function serialize(row: AttachmentRow): SerializedBlob {
  return {
    attachment_id: row.id,
    scope: row.scope as "agent" | "pane" | "template",
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    filename: row.filename,
    width: row.width,
    height: row.height,
    status: row.status,
    pane_id: row.paneId,
    template_id: row.templateId,
    created_at: row.createdAt.toISOString(),
    confirmed_at: row.confirmedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

// storageKeyFor is imported from ../../attachments/index.js (defined alongside the
// shared upload pipeline so both the /v1 route and the bridge route compute
// the same opaque storage key from a attachment id).

// Pagination defaults for GET /v1/attachments. The list endpoint uses an opaque
// (createdAt DESC, id DESC) cursor — mirrors how GET /v1/panes paginates
// so the agent only needs to learn one shape.
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

interface AttachmentListCursor {
  created_at: string;
  id: string;
}

function encodeBlobCursor(cur: AttachmentListCursor): string {
  return Buffer.from(JSON.stringify(cur), "utf8").toString("base64url");
}

function decodeBlobCursor(s: string): AttachmentListCursor | null {
  try {
    const decoded = Buffer.from(s, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as AttachmentListCursor).created_at !== "string" ||
      typeof (parsed as AttachmentListCursor).id !== "string"
    ) {
      return null;
    }
    const ts = new Date((parsed as AttachmentListCursor).created_at);
    if (Number.isNaN(ts.getTime())) return null;
    return parsed as AttachmentListCursor;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /v1/attachments — list the calling agent's non-deleted attachments.
//
// Ordered (createdAt DESC, id DESC), paginated via an opaque cursor that
// encodes the tuple of the last row on the previous page. Caller knobs:
//
//   ?cursor=<opaque>  resume after a given page boundary
//   ?limit=<n>        page size (1..100), defaults to 50
//
// Cross-tenant isolation: WHERE ownerId = me — every other attachment route in
// this file uses the same pattern.
// ---------------------------------------------------------------------------
attachments.get("/", async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");

  const limitRaw = c.req.query("limit");
  let limit = LIST_DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > LIST_MAX_LIMIT) {
      throw errors.invalidRequest(
        `invalid limit '${limitRaw}'`,
        undefined,
        `limit must be an integer in 1..${LIST_MAX_LIMIT}`,
      );
    }
    limit = n;
  }

  const cursorRaw = c.req.query("cursor");
  let cursor: AttachmentListCursor | null = null;
  if (cursorRaw !== undefined) {
    cursor = decodeBlobCursor(cursorRaw);
    if (cursor === null) {
      throw errors.invalidRequest(
        "invalid cursor",
        undefined,
        "the cursor must be the opaque `next_cursor` value returned by a previous page; do not construct it by hand",
      );
    }
  }

  const cursorWhere =
    cursor !== null
      ? {
          OR: [
            { createdAt: { lt: new Date(cursor.created_at) } },
            {
              createdAt: new Date(cursor.created_at),
              id: { lt: cursor.id },
            },
          ],
        }
      : {};

  const rows = await prisma.attachment.findMany({
    where: {
      ownerId: me.id,
      // Exclude soft-deleted attachments from the listing — they're audit-only.
      deletedAt: null,
      ...cursorWhere,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return c.json({
    items: page.map(serialize),
    next_cursor:
      hasMore && last
        ? encodeBlobCursor({
            created_at: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  });
});

// ---------------------------------------------------------------------------
// POST /v1/attachments — multipart upload.
//
// Form fields:
//   file        — required, the single binary file part
//   scope       — optional, defaults to "agent" (one of "agent" | "pane" |
//                  "template")
//   pane_id  — required when scope = "pane" (the agent must own the
//                  pane, or the v0.1.x foundation pane rejects it)
//   template_id — required when scope = "template" (the agent must own the
//                  template)
//   filename    — optional UX-only display name
//
// Cross-tenant attempts (uploading into a pane / template owned by a
// different agent) return attachment_not_found — never reveal whether the FK target
// actually exists.
// ---------------------------------------------------------------------------
attachments.post("/", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const store = c.get("blobStore");
  const me = c.get("agent");

  if (!store) {
    throw errors.invalidRequest(
      "attachment storage is not configured on this relay",
      undefined,
      "the operator has not configured a AttachmentStore; set BLOB_STORE=filesystem (default) or BLOB_STORE=azure and restart the relay",
    );
  }

  const form = await c.req.parseBody({ all: false });
  const file = form.file;
  if (!(file instanceof File)) {
    throw errors.invalidRequest(
      "missing 'file' part in multipart body",
      undefined,
      "POST a multipart/form-data body with a 'file' field carrying the binary upload",
    );
  }

  // Resolve scope + the matching FK. The FK rows are looked up under the
  // calling agent's ownership; a foreign FK returns attachment_not_found so we
  // never leak whether a pane/template id exists for another agent.
  const scope = parseScope(form.scope);
  const paneId = scope === "pane" ? requireFormString(form, "pane_id") : null;
  const templateId =
    scope === "template" ? requireFormString(form, "template_id") : null;

  if (paneId) {
    const ses = await prisma.pane.findUnique({
      where: { id: paneId },
      select: { agentId: true, status: true },
    });
    if (!ses || ses.agentId !== me.id) throw errors.blobNotFound();
    if (ses.status !== "open") throw errors.gone("pane is closed");
  }
  if (templateId) {
    const art = await prisma.template.findUnique({
      where: { id: templateId },
      select: { ownerId: true },
    });
    if (!art || art.ownerId !== me.id) throw errors.blobNotFound();
  }

  const final = await processBlobUpload(
    {
      prisma,
      config,
      store,
      quota: makeQuotaEnforcer(prisma, config, store),
    },
    {
      ownerId: me.id,
      scope,
      paneId,
      templateId,
      filename: typeof form.filename === "string" ? form.filename : null,
      file,
    },
  );

  return c.json(serialize(final), 201);
});

// ---------------------------------------------------------------------------
// Build a QuotaEnforcer that closes over this route's prisma/config/store
// trio. Used by both POST /v1/attachments (above) and the participant-side
// POST /s/:participantToken/attachments (in src/bridge/attachment-upload-bridge.ts).
// ---------------------------------------------------------------------------
export function makeQuotaEnforcer(
  prisma: PrismaClient,
  config: Config,
  store: AttachmentStore,
): QuotaEnforcer {
  return {
    enforce: ({ ownerId, paneId, templateId, extraBytes }) =>
      enforceQuotas(prisma, {
        ownerId,
        paneId,
        templateId,
        config,
        extraBytes,
        store,
      }),
  };
}

// ---------------------------------------------------------------------------
// GET /v1/attachments/:id — agent-auth download.
//
// Streams the bytes back with hardened response headers:
//   * Content-Type from the stored MIME (sniffed at upload time, never the
//     client's Content-Type — defends against the "HTML labelled as image"
//     class of attacks combined with browser MIME sniffing).
//   * X-Content-Type-Options: nosniff — tells the browser to obey the
//     declared Content-Type and not sniff into "is this actually HTML?"
//     territory.
//   * Content-Disposition: attachment for non-image MIME types — forces
//     download instead of inline render for PDFs etc.
//   * Cache-Control: private, no-store — agent-auth content should not be
//     cached by intermediaries.
//   * Cross-Origin-Resource-Policy: same-origin — denies speculative cross-
//     origin fetches.
// ---------------------------------------------------------------------------
attachments.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const store = c.get("blobStore");
  const me = c.get("agent");

  if (!store) {
    throw errors.invalidRequest(
      "attachment storage is not configured on this relay",
    );
  }

  const id = c.req.param("id");
  const row = await prisma.attachment.findUnique({ where: { id } });

  // Cross-tenant: a guessed id from a foreign agent returns attachment_not_found,
  // not forbidden — we never confirm the attachment exists to a non-owner.
  if (!row || row.ownerId !== me.id || row.status === "deleted") {
    throw errors.blobNotFound();
  }
  if (row.status !== "ready") {
    // pending / failed — exists but not downloadable. 404 keeps the pane
    // simple; a future PR could expose status separately if needed.
    throw errors.blobNotFound();
  }

  const stream = await store.get(row.storageKey);
  if (!stream) {
    // Metadata says ready, storage backend says missing — backend rot or
    // tampering. Mark the row failed so subsequent reads short-circuit, and
    // return 404 (we don't have the bytes; the caller can't recover here).
    await prisma.attachment.update({
      where: { id: row.id },
      data: { status: "failed" },
    });
    throw errors.blobNotFound();
  }

  // Decrypt (when encryption-at-rest is on for this attachment). The encryption
  // envelope is stored on the row; absent envelope = plaintext bytes in
  // the store (the BLOB_ENCRYPT_AT_REST was off when this attachment was
  // written). Decryption buffers the full attachment to verify the GCM tag —
  // bounded by MAX_BLOB_BYTES so memory cost is known.
  let outputStream: Readable = stream;
  if (row.encryptionEnvelope) {
    const { decryptBlob, parseEnvelope } =
      await import("../../attachments/encrypt.js");
    const { getMasterKey } = await import("../../crypto.js");
    const envelope = parseEnvelope(row.encryptionEnvelope);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const ciphertext = Buffer.concat(chunks);
    const plaintext = decryptBlob(ciphertext, envelope, getMasterKey());
    outputStream = Readable.from(plaintext);
  }

  // Hardened headers — see route doc comment above. Centralised in
  // setAttachmentDownloadHeaders so all attachment/icon paths share one
  // posture: nosniff, raster-only inline disposition (svg/everything-else →
  // attachment), no-store, same-origin CORP, no-referrer, and the framing
  // defences (CSP `default-src 'none'; sandbox; frame-ancestors 'none'` +
  // X-Frame-Options: DENY). Content-Length is the PLAINTEXT size; the row
  // stores that regardless of encryption.
  setAttachmentDownloadHeaders(c, { mime: row.mime, size: row.size });

  // Hono accepts a Web ReadableStream as the body; convert.
  return c.body(Readable.toWeb(outputStream) as unknown as ReadableStream);
});

// ---------------------------------------------------------------------------
// GET /v1/attachments/:id/metadata — agent-auth, metadata-only.
//
// Returns the same JSON shape that POST /v1/attachments returns (the full AttachmentRef:
// id, scope, mime, size, sha256, filename, width, height, status, scope
// FKs, timestamps). Use this when the agent needs the row's metadata
// without paying the cost of streaming + decrypting the bytes — e.g.
// `pane attachment show <id>`.
//
// Cross-tenant attempts collapse to attachment_not_found (same pane as the
// download route) so a foreign agent can't probe id existence.
// ---------------------------------------------------------------------------
attachments.get("/:id/metadata", async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");

  const id = c.req.param("id");
  const row = await prisma.attachment.findUnique({ where: { id } });

  // Same cross-tenant + status pane as GET /v1/attachments/:id — we treat
  // "deleted" as not-found, "pending" / "failed" as not-found (the agent
  // can't act on a not-ready attachment via this endpoint).
  if (!row || row.ownerId !== me.id || row.status === "deleted") {
    throw errors.blobNotFound();
  }
  if (row.status !== "ready") {
    throw errors.blobNotFound();
  }

  return c.json(serialize(row));
});

// ---------------------------------------------------------------------------
// DELETE /v1/attachments/:id — idempotent soft-delete.
//
// Removes the bytes from the AttachmentStore and marks the row deleted. Calling
// against an already-deleted id returns the same shape (deleted=true) so
// callers can safely retry on network errors.
// ---------------------------------------------------------------------------
attachments.delete("/:id", async (c) => {
  const prisma = c.get("prisma");
  const store = c.get("blobStore");
  const me = c.get("agent");

  if (!store) {
    throw errors.invalidRequest(
      "attachment storage is not configured on this relay",
    );
  }

  const id = c.req.param("id");
  const row = await prisma.attachment.findUnique({ where: { id } });

  // Foreign agent / no such attachment → attachment_not_found (same pane as GET).
  if (!row || row.ownerId !== me.id) {
    throw errors.blobNotFound();
  }

  // Already deleted: return the same successful shape.
  if (row.status === "deleted") {
    return c.json({ attachment_id: row.id, deleted: true });
  }

  // Best-effort backend delete then mark the row. If the backend delete
  // fails we still mark the row deleted — the bytes are orphaned and a
  // later janitor can sweep, but the caller's intent is satisfied (the
  // row is no longer reachable through any API).
  await store.delete(row.storageKey).catch(() => {
    /* best-effort; orphan-sweep job lands in hardening PR */
  });

  await prisma.attachment.update({
    where: { id: row.id },
    data: { status: "deleted", deletedAt: new Date() },
  });

  return c.json({ attachment_id: row.id, deleted: true });
});

// ---------------------------------------------------------------------------
// POST /v1/attachments/presign — issue a presigned PUT URL for direct-to-storage
// upload.
//
// Body (JSON, required):
//   {
//     mime: string,                    // declared content-type
//     size: integer,                   // committed byte length
//     sha256: string (hex),            // committed content hash
//     scope: "agent" | "pane" | "template",
//     pane_id?: string,             // required for scope=pane
//     template_id?: string,            // required for scope=template
//     filename?: string                // UX-only display name
//   }
//
// Returns:
//   { attachment_id, upload_url, expires_at, headers? }
//
// The client uploads the bytes directly to `upload_url` (PUT), then calls
// POST /v1/attachments/:id/confirm. The relay HEADs storage on confirm and verifies
// size + sha256 against the values committed here (TOCTOU defence).
//
// Only Azure backend supports presign in v0.1.0. Filesystem backend returns
// 501 not_implemented — the multipart fallback (POST /v1/attachments) covers FS.
// ---------------------------------------------------------------------------
attachments.post("/presign", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const store = c.get("blobStore");
  const me = c.get("agent");

  if (!store) {
    throw errors.invalidRequest(
      "attachment storage is not configured on this relay",
    );
  }
  // Capability check — presign is Azure-only for now.
  if (!("presignPut" in store) || !("confirmPresigned" in store)) {
    throw errors.notImplemented(
      "presigned upload is not supported by this backend",
      "the filesystem backend uses the multipart fallback (POST /v1/attachments) instead; set BLOB_STORE=azure to enable the presigned PUT flow",
    );
  }

  const body = (await c.req.json().catch(() => null)) as {
    mime?: unknown;
    size?: unknown;
    sha256?: unknown;
    scope?: unknown;
    pane_id?: unknown;
    template_id?: unknown;
    filename?: unknown;
  } | null;
  if (!body) throw errors.invalidRequest("missing JSON body");

  const mime = typeof body.mime === "string" ? body.mime : null;
  const size = typeof body.size === "number" ? body.size : null;
  const sha256 = typeof body.sha256 === "string" ? body.sha256 : null;
  if (!mime || size === null || !sha256) {
    throw errors.invalidRequest(
      "presign body requires mime, size (int), sha256 (hex)",
    );
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw errors.invalidRequest("size must be a positive integer");
  }
  if (size > config.MAX_BLOB_BYTES) {
    throw errors.blobSizeExceeded(config.MAX_BLOB_BYTES);
  }
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw errors.invalidRequest("sha256 must be a 64-character hex string");
  }
  if (!isMimeAllowed(mime, config.BLOB_MIME_ALLOWLIST)) {
    throw errors.mimeDisallowed(mime, config.BLOB_MIME_ALLOWLIST);
  }

  const scope = parseScope(body.scope);
  const paneId =
    scope === "pane"
      ? typeof body.pane_id === "string"
        ? body.pane_id
        : (() => {
            throw errors.invalidRequest("scope=pane requires pane_id");
          })()
      : null;
  const templateId =
    scope === "template"
      ? typeof body.template_id === "string"
        ? body.template_id
        : (() => {
            throw errors.invalidRequest("scope=template requires template_id");
          })()
      : null;

  if (paneId) {
    const ses = await prisma.pane.findUnique({
      where: { id: paneId },
      select: { agentId: true, status: true },
    });
    if (!ses || ses.agentId !== me.id) throw errors.blobNotFound();
    if (ses.status !== "open") throw errors.gone("pane is closed");
  }
  if (templateId) {
    const art = await prisma.template.findUnique({
      where: { id: templateId },
      select: { ownerId: true },
    });
    if (!art || art.ownerId !== me.id) throw errors.blobNotFound();
  }

  // Pre-check the agent + per-scope quotas using the committed size (rejects
  // upfront; saves a wasted round trip to storage). The bytes don't exist
  // yet so we pass `extraBytes: size` to project the eventual aggregate.
  const quotaFailure = await enforceQuotas(prisma, {
    ownerId: me.id,
    paneId,
    templateId,
    config,
    extraBytes: size,
  });
  if (quotaFailure) {
    throw errors.quotaExceeded(quotaFailure.scope, quotaFailure.cap);
  }

  // Reserve a row with status=pending so we have an id to derive the
  // storage key from. The actual size/sha256/confirmedAt land in the
  // /confirm step.
  const row = await prisma.attachment.create({
    data: {
      ownerId: me.id,
      scope,
      paneId,
      templateId,
      mime,
      size,
      sha256,
      filename: typeof body.filename === "string" ? body.filename : null,
      storageKey: "",
      status: "pending",
    },
  });
  const storageKey = storageKeyFor(row.id);
  await prisma.attachment.update({
    where: { id: row.id },
    data: { storageKey },
  });

  // Mint the presigned PUT. The store capability check above guaranteed
  // these methods exist.
  const presign = await (
    store as unknown as {
      presignPut: (opts: {
        key: string;
        mime: string;
        sha256: string;
      }) => Promise<{ uploadUrl: string; expiresAt: Date }>;
    }
  ).presignPut({ key: storageKey, mime, sha256 });

  return c.json(
    {
      attachment_id: row.id,
      upload_url: presign.uploadUrl,
      expires_at: presign.expiresAt.toISOString(),
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// POST /v1/attachments/:id/confirm — finalise a presigned upload.
//
// Called by the client AFTER it has PUT the bytes to the upload_url from
// /v1/attachments/presign. The relay HEADs the storage backend, verifies size +
// sha256 match the committed values, and flips status: pending → ready.
//
// Mismatch → 422 attachment_integrity_violation; the bytes are deleted from
// storage and the row is marked failed.
// ---------------------------------------------------------------------------
attachments.post("/:id/confirm", async (c) => {
  const prisma = c.get("prisma");
  const store = c.get("blobStore");
  const me = c.get("agent");

  if (!store) {
    throw errors.invalidRequest(
      "attachment storage is not configured on this relay",
    );
  }
  if (!("confirmPresigned" in store)) {
    throw errors.notImplemented(
      "confirm is only valid against backends that support presigned PUT",
    );
  }

  const id = c.req.param("id");
  const row = await prisma.attachment.findUnique({ where: { id } });
  if (!row || row.ownerId !== me.id) throw errors.blobNotFound();
  if (row.status !== "pending") {
    // Already confirmed (or failed). Idempotent: return current shape if
    // ready; otherwise 409 conflict.
    if (row.status === "ready") return c.json(serialize(row), 200);
    throw errors.conflict(
      `attachment is in status='${row.status}' and cannot be confirmed`,
    );
  }

  try {
    const info = await (
      store as unknown as {
        confirmPresigned: (
          key: string,
          expected: { size: number; sha256: string; mime: string },
        ) => Promise<{ size: number; sha256: string; mime?: string }>;
      }
    ).confirmPresigned(row.storageKey, {
      size: row.size,
      sha256: row.sha256,
      mime: row.mime,
    });

    const final = await prisma.attachment.update({
      where: { id: row.id },
      data: {
        status: "ready",
        // Use the verified values from the backend, not the committed ones —
        // a defence-in-depth measure if the integrity check ever loosens.
        size: info.size,
        sha256: info.sha256,
        confirmedAt: new Date(),
      },
    });
    return c.json(serialize(final), 200);
  } catch (e) {
    await prisma.attachment
      .update({ where: { id: row.id }, data: { status: "failed" } })
      .catch(() => {
        /* best-effort */
      });
    if (e instanceof AttachmentIntegrityError) {
      throw errors.invalidRequest(
        "uploaded bytes don't match the committed size + sha256",
        {
          expected: e.expected,
          observed: e.observed,
        },
        "the bytes at the upload_url disagree with what was committed at presign time; re-request a presign with the correct values",
      );
    }
    throw e;
  }
});

// ---------------------------------------------------------------------------
// GET /v1/attachments/:id/tokens — enumerate the capability tokens on one attachment.
//
// Audit endpoint. Returns ALL tokens (active, expired, and revoked) so the
// agent can correlate a revoked_at on a row with whatever they minted. The
// plaintext token is NEVER returned (it isn't even stored — only the sha256
// of the plaintext is); only the prefix is included so an operator can match
// a redacted access-log line against the row.
//
// Cross-tenant isolation: the agent must own the parent attachment. Otherwise we'd
// leak "this attachment exists" via the 200-vs-404 channel.
// ---------------------------------------------------------------------------
attachments.get("/:id/tokens", async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");

  const attachmentId = c.req.param("id");
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: { id: true, ownerId: true },
  });
  if (!attachment || attachment.ownerId !== me.id) throw errors.blobNotFound();

  const rows = await prisma.attachmentToken.findMany({
    where: { attachmentId: attachment.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      tokenPrefix: true,
      expiresAt: true,
      once: true,
      createdAt: true,
      lastUsedAt: true,
      useCount: true,
      revokedAt: true,
    },
  });

  return c.json({
    attachment_id: attachment.id,
    items: rows.map((r) => ({
      token_id: r.id,
      token_prefix: r.tokenPrefix,
      expires_at: r.expiresAt.toISOString(),
      once: r.once,
      created_at: r.createdAt.toISOString(),
      last_used_at: r.lastUsedAt?.toISOString() ?? null,
      use_count: r.useCount,
      revoked_at: r.revokedAt?.toISOString() ?? null,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /v1/attachments/:id/tokens — mint a /b/<token> capability URL.
//
// Body (JSON, optional):
//   { ttl_seconds?: number, once?: boolean }
//
// TTL defaults per scope:
//   - pane-scope:  matches the pane's expiresAt (cascades on pane delete)
//   - agent-scope:    BLOB_TOKEN_TTL_AGENT_SECONDS (24h default)
//   - template-scope: BLOB_TOKEN_TTL_ARTIFACT_SECONDS (30d default)
//
// `ttl_seconds` overrides the default within a per-scope upper bound (the
// default; you can shorten, never lengthen — protects against operators
// being talked into a "just-this-once" override that becomes the norm).
// `once = true` makes the resulting token self-delete on first successful GET.
//
// Returns: { token, url, expires_at, once, token_id }. The full `token` is
// only ever returned once, here — subsequent reads see only the prefix.
// ---------------------------------------------------------------------------
attachments.post("/:id/tokens", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const me = c.get("agent");

  const id = c.req.param("id");
  const attachment = await prisma.attachment.findUnique({ where: { id } });
  if (
    !attachment ||
    attachment.ownerId !== me.id ||
    attachment.status === "deleted"
  ) {
    throw errors.blobNotFound();
  }
  if (attachment.status !== "ready") throw errors.blobNotFound();

  const body = (await c.req.json().catch(() => ({}))) as {
    ttl_seconds?: unknown;
    once?: unknown;
  };
  const once = body.once === true;

  // Compute default TTL by scope, then accept a caller-supplied shorter TTL
  // (never longer — the per-scope default is the ceiling).
  const expiresAt = await computeTokenExpiry(
    prisma,
    attachment,
    config,
    body.ttl_seconds,
  );

  const minted = generateBlobToken();
  const tokenRow = await prisma.attachmentToken.create({
    data: {
      attachmentId: attachment.id,
      tokenHash: minted.hash,
      tokenPrefix: minted.prefix,
      expiresAt,
      once,
    },
    select: { id: true, tokenPrefix: true, expiresAt: true, once: true },
  });

  // The full token only appears in this response. The DB stores its hash;
  // the prefix is kept for log correlation.
  const url = `${publicUrl(config)}/b/${minted.token}`;
  return c.json(
    {
      token_id: tokenRow.id,
      token: minted.token,
      token_prefix: tokenRow.tokenPrefix,
      url,
      expires_at: tokenRow.expiresAt.toISOString(),
      once: tokenRow.once,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// DELETE /v1/attachments/:id/tokens/:token_id — revoke a token.
//
// Idempotent: revoking an already-revoked or expired token returns the same
// shape. Adds the token's hash to the in-memory revoke cache so subsequent
// /b/<token> requests short-circuit without a DB read.
// ---------------------------------------------------------------------------
attachments.delete("/:id/tokens/:token_id", async (c) => {
  const prisma = c.get("prisma");
  const cache = c.get("blobRevokeCache");
  const me = c.get("agent");

  const attachmentId = c.req.param("id");
  const tokenId = c.req.param("token_id");

  // Verify the agent owns the parent attachment — otherwise we'd leak that a
  // token id exists for someone else's attachment via the 404 vs. 200 channel.
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: { ownerId: true },
  });
  if (!attachment || attachment.ownerId !== me.id) throw errors.blobNotFound();

  const tok = await prisma.attachmentToken.findUnique({
    where: { id: tokenId },
    select: { id: true, attachmentId: true, tokenHash: true, revokedAt: true },
  });
  if (!tok || tok.attachmentId !== attachmentId)
    throw errors.blobTokenNotFound();

  if (tok.revokedAt) {
    // Already revoked — return the idempotent shape.
    cache?.add(tok.tokenHash);
    return c.json({ token_id: tok.id, revoked: true });
  }

  await prisma.attachmentToken.update({
    where: { id: tok.id },
    data: { revokedAt: new Date() },
  });
  cache?.add(tok.tokenHash);
  return c.json({ token_id: tok.id, revoked: true });
});

// ===========================================================================
// Helpers — kept private to this module so the route file stays the entire
// pane for /v1/attachments.
// ===========================================================================

/**
 * Parse the `scope` form field. Empty / missing defaults to `agent`. Anything
 * outside the enum is rejected as `invalid_request`.
 */
function parseScope(raw: unknown): "agent" | "pane" | "template" {
  if (raw === undefined || raw === null || raw === "") return "agent";
  if (raw === "agent" || raw === "pane" || raw === "template") return raw;
  throw errors.invalidRequest(
    `unknown scope='${String(raw)}'`,
    { scope: String(raw), supported: ["agent", "pane", "template"] },
    "pass scope=agent|pane|template; pane-scope requires pane_id, template-scope requires template_id",
  );
}

/** Required-string accessor for parseBody output. Throws invalid_request when missing. */
function requireFormString(
  form: Record<string, unknown>,
  field: string,
): string {
  const v = form[field];
  if (typeof v !== "string" || v.length === 0) {
    throw errors.invalidRequest(
      `missing form field '${field}'`,
      undefined,
      `the '${field}' field is required for this scope`,
    );
  }
  return v;
}

interface QuotaFailure {
  scope: "agent" | "pane" | "template";
  cap: number;
}

/**
 * Enforce post-write aggregate quotas. Returns null when every relevant
 * cap is satisfied, or a {scope, cap} describing the first failure.
 */
async function enforceQuotas(
  prisma: PrismaClient,
  opts: {
    ownerId: string;
    paneId: string | null;
    templateId: string | null;
    config: Config;
    /**
     * Bytes that have been written to the AttachmentStore but whose Blob row
     * still carries the placeholder `size: 0`. The route adds these into
     * the aggregate so the just-written attachment is counted before the commit
     * UPDATE lands.
     */
    extraBytes: number;
    /**
     * Optional AttachmentStore handle so eviction can clean up the storage
     * backend's bytes too. Omitted when this helper is called from
     * `POST /v1/attachments/presign` (no attachment written yet — eviction is a row-
     * level + cache-level concern there, the bytes don't exist yet).
     */
    store?: { delete: (key: string) => Promise<void> };
  },
): Promise<QuotaFailure | null> {
  const { ownerId, paneId, templateId, config, extraBytes, store } = opts;

  // Per-agent — always applies. When over the cap and LRU eviction is on,
  // remove the oldest agent-scope attachments until the new one fits. Pane +
  // template-scope attachments are NEVER evicted: they're tied to a live parent.
  let agentTotal =
    (
      await prisma.attachment.aggregate({
        where: { ownerId, status: { in: ["pending", "ready"] } },
        _sum: { size: true },
      })
    )._sum.size ?? 0;

  if (agentTotal + extraBytes > config.MAX_BLOBS_PER_AGENT_BYTES) {
    if (!config.BLOB_LRU_EVICTION) {
      return { scope: "agent", cap: config.MAX_BLOBS_PER_AGENT_BYTES };
    }

    // LRU eviction: oldest agent-scope attachment first, until the new upload
    // would fit. Loop bounded by the number of evictable rows so a bug
    // can't spin forever.
    const evictable = await prisma.attachment.findMany({
      where: {
        ownerId,
        scope: "agent",
        status: { in: ["pending", "ready"] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, size: true, storageKey: true },
    });
    for (const row of evictable) {
      if (agentTotal + extraBytes <= config.MAX_BLOBS_PER_AGENT_BYTES) {
        break;
      }
      if (store) {
        await store.delete(row.storageKey).catch(() => {
          /* best-effort; orphan-sweep handles stragglers */
        });
      }
      await prisma.attachment.update({
        where: { id: row.id },
        data: { status: "deleted", deletedAt: new Date() },
      });
      agentTotal -= row.size;
    }

    // Re-check after the eviction loop. If we're still over, the new attachment
    // is too big even after evicting every agent-scope attachment — reject.
    if (agentTotal + extraBytes > config.MAX_BLOBS_PER_AGENT_BYTES) {
      return { scope: "agent", cap: config.MAX_BLOBS_PER_AGENT_BYTES };
    }
  }

  if (paneId) {
    const ses = await prisma.attachment.aggregate({
      where: { paneId, status: { in: ["pending", "ready"] } },
      _sum: { size: true },
    });
    if ((ses._sum.size ?? 0) + extraBytes > config.MAX_BLOBS_PER_PANE_BYTES) {
      return { scope: "pane", cap: config.MAX_BLOBS_PER_PANE_BYTES };
    }
  }

  if (templateId) {
    const art = await prisma.attachment.aggregate({
      where: { templateId, status: { in: ["pending", "ready"] } },
      _sum: { size: true },
    });
    if (
      (art._sum.size ?? 0) + extraBytes >
      config.MAX_BLOBS_PER_ARTIFACT_BYTES
    ) {
      return { scope: "template", cap: config.MAX_BLOBS_PER_ARTIFACT_BYTES };
    }
  }

  return null;
}

/**
 * Compute the expiresAt for a freshly-minted token, applying the scope's
 * default and accepting a caller override only if it's shorter (the default
 * is the ceiling — never extend past it).
 */
async function computeTokenExpiry(
  prisma: PrismaClient,
  attachment: { scope: string; paneId: string | null },
  config: Config,
  ttlSecondsRaw: unknown,
): Promise<Date> {
  const now = Date.now();
  let defaultExpiry: Date;

  if (attachment.scope === "pane") {
    if (!attachment.paneId) {
      // Shouldn't happen — pane-scope attachments always have paneId set —
      // but be defensive.
      throw errors.invalidRequest(
        "pane-scope attachment is missing pane_id (data integrity issue)",
      );
    }
    const ses = await prisma.pane.findUnique({
      where: { id: attachment.paneId },
      select: { expiresAt: true },
    });
    if (!ses) {
      // The cascade would normally take the attachment with the pane; if we're
      // still here the row is racing the deletion. Treat as a not-found.
      throw errors.blobNotFound();
    }
    defaultExpiry = ses.expiresAt;
  } else if (attachment.scope === "template") {
    defaultExpiry = new Date(
      now + config.BLOB_TOKEN_TTL_ARTIFACT_SECONDS * 1000,
    );
  } else {
    // agent scope
    defaultExpiry = new Date(now + config.BLOB_TOKEN_TTL_AGENT_SECONDS * 1000);
  }

  if (
    ttlSecondsRaw !== undefined &&
    typeof ttlSecondsRaw === "number" &&
    Number.isInteger(ttlSecondsRaw) &&
    ttlSecondsRaw > 0
  ) {
    const requested = new Date(now + ttlSecondsRaw * 1000);
    // Caller can only shorten — the scope default is the ceiling.
    return requested < defaultExpiry ? requested : defaultExpiry;
  }
  return defaultExpiry;
}

/** Best-effort PUBLIC_URL for token URLs; falls back to config.publicUrl. */
function publicUrl(config: Config): string {
  // config.publicUrl is the resolved, host-correct base for everything the
  // human sees. /s/<token> uses the same. Match.
  return (config.publicUrl ?? "").replace(/\/$/, "");
}

export default attachments;
