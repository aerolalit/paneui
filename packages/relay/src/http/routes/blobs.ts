// /v1/blobs — binary attachments owned by an agent.
//
// PR scope (feat/blobs-foundation):
//   POST   /v1/blobs           multipart upload, agent-scope only (v1)
//   GET    /v1/blobs/:id       agent-auth download
//   DELETE /v1/blobs/:id       soft-delete (idempotent)
//
// Out of scope for this PR — landing in later stack PRs against feat/blobs:
//   * session + artifact scopes (PR #2)
//   * presigned PUT direct-to-storage path (PR #3)
//   * /b/<token> capability URL (PR #2)
//   * polyglot defense + EXIF strip via sharp (PR #5)
//
// Every upload runs through server-side magic-byte MIME sniffing
// (mime-sniff.ts) — the client's Content-Type is never trusted. Sniff
// mismatch → 415 mime_mismatch. Disallowed MIME → 415 mime_disallowed.
// Size exceeding MAX_BLOB_BYTES → 413 blob_size_exceeded.

import { Hono } from "hono";
import { Readable } from "node:stream";
import { requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import {
  BlobSizeExceededError,
  isMimeAllowed,
  sniffMime,
} from "../../blobs/index.js";

const blobs = new Hono<AuthEnv>();
blobs.use("*", requireAgent);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SerializedBlob {
  blob_id: string;
  scope: "agent" | "session" | "artifact";
  mime: string;
  size: number;
  sha256: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  status: string;
  session_id: string | null;
  artifact_id: string | null;
  created_at: string;
  confirmed_at: string | null;
  deleted_at: string | null;
}

interface BlobRow {
  id: string;
  scope: string;
  mime: string;
  size: number;
  sha256: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  status: string;
  sessionId: string | null;
  artifactId: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  deletedAt: Date | null;
}

function serialize(row: BlobRow): SerializedBlob {
  return {
    blob_id: row.id,
    scope: row.scope as "agent" | "session" | "artifact",
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    filename: row.filename,
    width: row.width,
    height: row.height,
    status: row.status,
    session_id: row.sessionId,
    artifact_id: row.artifactId,
    created_at: row.createdAt.toISOString(),
    confirmed_at: row.confirmedAt?.toISOString() ?? null,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

/** Storage key derived from the blob id. Opaque, never user-supplied. */
function storageKeyFor(blobId: string): string {
  return `blob_${blobId}`;
}

// ---------------------------------------------------------------------------
// POST /v1/blobs — multipart upload.
//
// PR #1 (foundation) accepts agent-scope only. Future PRs widen this to
// session + artifact scope; clients passing `scope=session|artifact` today
// get a clean error pointing at #152 rather than silent agent-scope coercion.
//
// Form fields:
//   file       — required, the single binary file part
//   scope      — optional, defaults to "agent" (only value accepted in v1
//                foundation; "session"/"artifact" land in PR #2)
//   filename   — optional UX-only display name
// ---------------------------------------------------------------------------
blobs.post("/", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const store = c.get("blobStore");
  const me = c.get("agent");

  if (!store) {
    throw errors.invalidRequest(
      "blob storage is not configured on this relay",
      undefined,
      "the operator has not configured a BlobStore; set BLOB_STORE=filesystem (default) or BLOB_STORE=azure and restart the relay",
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

  // Scope gating. PR #1 supports agent-scope only; future PRs accept
  // "session" (with session_id) and "artifact" (with artifact_id).
  const scopeRaw = typeof form.scope === "string" ? form.scope : "agent";
  if (scopeRaw !== "agent") {
    throw errors.invalidRequest(
      `scope='${scopeRaw}' is not yet supported`,
      { scope: scopeRaw, supported: ["agent"] },
      "this relay's foundation release accepts scope='agent' only; session + artifact scope are tracked in pane #152 (PR feat/blobs-scopes-tokens)",
    );
  }

  // Cheap declared-Content-Type check. The authoritative check happens
  // after we have leading bytes (sniff vs. allowlist).
  const declaredMime = file.type || "application/octet-stream";

  // Read the first chunk from a single reader so we can sniff the MIME, then
  // resume from the same reader for the rest of the bytes. Calling
  // `file.stream()` a second time would return a fresh ReadableStream from
  // the start — duplicating the file content — so we keep one reader and
  // hand it back to the BlobStore via a generator that yields firstChunk
  // first, then the remaining reads.
  const reader = file.stream().getReader();
  const { value: firstChunk, done: streamDone } = await reader.read();

  if (!firstChunk || firstChunk.length === 0) {
    reader.releaseLock();
    throw errors.invalidRequest(
      "uploaded file is empty",
      undefined,
      "the multipart 'file' part contains no bytes; upload a non-empty file",
    );
  }

  const sniffWindow =
    firstChunk.length >= 64 ? firstChunk.subarray(0, 64) : firstChunk;
  const sniffedMime = sniffMime(sniffWindow);

  // 1. Mismatch check — declared vs. sniffed. We accept image/jpeg both ways
  //    and `application/octet-stream` as "I don't know, you decide" but
  //    refuse declared text/html when bytes are image/jpeg etc.
  const declaredIsGeneric = declaredMime === "application/octet-stream";
  if (!declaredIsGeneric && declaredMime !== sniffedMime) {
    reader.releaseLock();
    throw errors.mimeMismatch(declaredMime, sniffedMime);
  }

  // 2. Allowlist check — must match BLOB_MIME_ALLOWLIST.
  if (!isMimeAllowed(sniffedMime, config.BLOB_MIME_ALLOWLIST)) {
    reader.releaseLock();
    throw errors.mimeDisallowed(sniffedMime, config.BLOB_MIME_ALLOWLIST);
  }

  // Build a Node Readable that yields the chunk we already consumed, then
  // drains the rest of the SAME reader. Calling `file.stream()` again would
  // produce a fresh stream from the start and double-count the bytes.
  let fullStream: Readable;
  if (streamDone) {
    reader.releaseLock();
    fullStream = Readable.from(Buffer.from(firstChunk));
  } else {
    fullStream = streamFromReader(firstChunk, reader);
  }

  // Create the blob row first (status=pending) so we have an id to derive
  // the storage key from. If the upload fails after this point, we mark the
  // row failed (a janitor task in a later PR sweeps these).
  const row = await prisma.blob.create({
    data: {
      ownerId: me.id,
      scope: "agent",
      mime: sniffedMime,
      size: 0,
      sha256: "",
      filename: typeof form.filename === "string" ? form.filename : null,
      storageKey: "", // placeholder, set on the same row after we know the id
      status: "pending",
    },
  });
  // Now that we have the row id, derive the storage key and update.
  const storageKey = storageKeyFor(row.id);
  await prisma.blob.update({
    where: { id: row.id },
    data: { storageKey },
  });

  // Stream into the BlobStore. The store enforces the size cap mid-stream
  // and computes sha256 + total size as it goes.
  let info;
  try {
    info = await store.put(storageKey, fullStream, {
      mime: sniffedMime,
      maxBytes: config.MAX_BLOB_BYTES,
    });
  } catch (e) {
    // On any failure, mark the row failed and propagate a clean error.
    await prisma.blob
      .update({ where: { id: row.id }, data: { status: "failed" } })
      .catch(() => {
        /* best-effort */
      });

    if (e instanceof BlobSizeExceededError) {
      throw errors.blobSizeExceeded(config.MAX_BLOB_BYTES);
    }
    throw e;
  }

  // Per-agent aggregate quota — sum the agent's existing ready blobs and
  // check against the cap. Done after the write so we don't double-count
  // the just-written blob's bytes from a pre-write query. A racing parallel
  // upload could push the total slightly over the cap; LRU eviction in the
  // hardening PR cleans that up.
  const aggregate = await prisma.blob.aggregate({
    where: { ownerId: me.id, status: { in: ["pending", "ready"] } },
    _sum: { size: true },
  });
  const totalBytes = (aggregate._sum.size ?? 0) + info.size;
  if (totalBytes > config.MAX_BLOBS_PER_AGENT_BYTES) {
    // Roll back: delete the just-written bytes and mark the row failed.
    await store.delete(storageKey).catch(() => {
      /* best-effort */
    });
    await prisma.blob.update({
      where: { id: row.id },
      data: { status: "failed" },
    });
    throw errors.quotaExceeded("agent", config.MAX_BLOBS_PER_AGENT_BYTES);
  }

  // Commit: mark ready, fill in real size + sha256.
  const final = await prisma.blob.update({
    where: { id: row.id },
    data: {
      status: "ready",
      size: info.size,
      sha256: info.sha256,
      confirmedAt: new Date(),
    },
  });

  return c.json(serialize(final), 201);
});

/**
 * Build a Node Readable from a single `ReadableStreamDefaultReader` whose
 * first chunk has already been consumed. Yields the saved chunk first, then
 * drains the rest of the same reader. Releases the reader on EOF or
 * abandonment.
 *
 * The reader is locked to its underlying ReadableStream — we never re-open
 * `file.stream()`, so the total bytes pulled equal the file's real length.
 */
function streamFromReader(
  first: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Readable {
  return Readable.from(
    (async function* () {
      try {
        yield Buffer.from(first);
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          if (value && value.length) yield Buffer.from(value);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    })(),
  );
}

// ---------------------------------------------------------------------------
// GET /v1/blobs/:id — agent-auth download.
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
blobs.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const store = c.get("blobStore");
  const me = c.get("agent");

  if (!store) {
    throw errors.invalidRequest("blob storage is not configured on this relay");
  }

  const id = c.req.param("id");
  const row = await prisma.blob.findUnique({ where: { id } });

  // Cross-tenant: a guessed id from a foreign agent returns blob_not_found,
  // not forbidden — we never confirm the blob exists to a non-owner.
  if (!row || row.ownerId !== me.id || row.status === "deleted") {
    throw errors.blobNotFound();
  }
  if (row.status !== "ready") {
    // pending / failed — exists but not downloadable. 404 keeps the surface
    // simple; a future PR could expose status separately if needed.
    throw errors.blobNotFound();
  }

  const stream = await store.get(row.storageKey);
  if (!stream) {
    // Metadata says ready, storage backend says missing — backend rot or
    // tampering. Mark the row failed so subsequent reads short-circuit, and
    // return 404 (we don't have the bytes; the caller can't recover here).
    await prisma.blob.update({
      where: { id: row.id },
      data: { status: "failed" },
    });
    throw errors.blobNotFound();
  }

  // Hardened headers — see route doc comment above.
  c.header("Content-Type", row.mime);
  c.header("Content-Length", String(row.size));
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Disposition",
    row.mime.startsWith("image/") ? "inline" : "attachment",
  );
  c.header("Cache-Control", "private, no-store");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Referrer-Policy", "no-referrer");

  // Hono accepts a Web ReadableStream as the body; convert.
  return c.body(Readable.toWeb(stream) as unknown as ReadableStream);
});

// ---------------------------------------------------------------------------
// DELETE /v1/blobs/:id — idempotent soft-delete.
//
// Removes the bytes from the BlobStore and marks the row deleted. Calling
// against an already-deleted id returns the same shape (deleted=true) so
// callers can safely retry on network errors.
// ---------------------------------------------------------------------------
blobs.delete("/:id", async (c) => {
  const prisma = c.get("prisma");
  const store = c.get("blobStore");
  const me = c.get("agent");

  if (!store) {
    throw errors.invalidRequest("blob storage is not configured on this relay");
  }

  const id = c.req.param("id");
  const row = await prisma.blob.findUnique({ where: { id } });

  // Foreign agent / no such blob → blob_not_found (same surface as GET).
  if (!row || row.ownerId !== me.id) {
    throw errors.blobNotFound();
  }

  // Already deleted: return the same successful shape.
  if (row.status === "deleted") {
    return c.json({ blob_id: row.id, deleted: true });
  }

  // Best-effort backend delete then mark the row. If the backend delete
  // fails we still mark the row deleted — the bytes are orphaned and a
  // later janitor can sweep, but the caller's intent is satisfied (the
  // row is no longer reachable through any API).
  await store.delete(row.storageKey).catch(() => {
    /* best-effort; orphan-sweep job lands in hardening PR */
  });

  await prisma.blob.update({
    where: { id: row.id },
    data: { status: "deleted", deletedAt: new Date() },
  });

  return c.json({ blob_id: row.id, deleted: true });
});

export default blobs;
