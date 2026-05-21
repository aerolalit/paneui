// /v1/blobs — binary attachments owned by an agent.
//
// Endpoints in this module:
//   POST   /v1/blobs                          multipart upload, three scopes
//   GET    /v1/blobs/:id                      agent-auth download
//   DELETE /v1/blobs/:id                      soft-delete (idempotent)
//   POST   /v1/blobs/:id/tokens               mint a /b/<token> capability URL
//   DELETE /v1/blobs/:id/tokens/:token_id     revoke a token
//
// The /b/<token> fetch path itself lives in src/bridge/blob-bridge.ts so the
// no-auth surface is clearly separated from the agent-auth one here.
//
// Out of scope for the foundation stack — landing in later PRs against
// feat/blobs:
//   * AzureBlobStore + POST /v1/blobs/presign direct-to-storage path
//   * pane.uploadBlob() in @paneui/core + pane blob * subcommands in CLI
//   * polyglot defense + EXIF strip via sharp
//   * envelope encryption-at-rest, scan hook, LRU eviction, audit-history
//
// Every upload runs through server-side magic-byte MIME sniffing
// (mime-sniff.ts) — the client's Content-Type is never trusted. Sniff
// mismatch → 415 mime_mismatch. Disallowed MIME → 415 mime_disallowed.
// Size exceeding MAX_BLOB_BYTES → 413 blob_size_exceeded.

import { Hono } from "hono";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../../config.js";
import { requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import {
  BlobSizeExceededError,
  generateBlobToken,
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
// Form fields:
//   file        — required, the single binary file part
//   scope       — optional, defaults to "agent" (one of "agent" | "session" |
//                  "artifact")
//   session_id  — required when scope = "session" (the agent must own the
//                  session, or the v0.1.x foundation surface rejects it)
//   artifact_id — required when scope = "artifact" (the agent must own the
//                  artifact)
//   filename    — optional UX-only display name
//
// Cross-tenant attempts (uploading into a session / artifact owned by a
// different agent) return blob_not_found — never reveal whether the FK target
// actually exists.
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

  // Resolve scope + the matching FK. The FK rows are looked up under the
  // calling agent's ownership; a foreign FK returns blob_not_found so we
  // never leak whether a session/artifact id exists for another agent.
  const scope = parseScope(form.scope);
  const sessionId =
    scope === "session" ? requireFormString(form, "session_id") : null;
  const artifactId =
    scope === "artifact" ? requireFormString(form, "artifact_id") : null;

  if (sessionId) {
    const ses = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { agentId: true, status: true },
    });
    if (!ses || ses.agentId !== me.id) throw errors.blobNotFound();
    if (ses.status !== "open") throw errors.gone("session is closed");
  }
  if (artifactId) {
    const art = await prisma.artifact.findUnique({
      where: { id: artifactId },
      select: { ownerId: true },
    });
    if (!art || art.ownerId !== me.id) throw errors.blobNotFound();
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
      scope,
      sessionId,
      artifactId,
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

  // Aggregate quotas. The per-agent cap applies to EVERY scope (an agent's
  // total footprint across all blobs they own). The per-session or per-
  // artifact cap applies on top of that when relevant. A racing parallel
  // upload could push a total slightly over the cap; LRU eviction in the
  // hardening PR cleans that up. The just-written row still has its
  // placeholder `size: 0` at this point (the real size is written on the
  // commit update below), so we add `info.size` into the aggregate manually.
  const quotaFailure = await enforceQuotas(prisma, {
    ownerId: me.id,
    sessionId,
    artifactId,
    config,
    extraBytes: info.size,
  });
  if (quotaFailure) {
    // Roll back: delete the bytes and mark the row failed.
    await store.delete(storageKey).catch(() => {
      /* best-effort */
    });
    await prisma.blob.update({
      where: { id: row.id },
      data: { status: "failed" },
    });
    throw errors.quotaExceeded(quotaFailure.scope, quotaFailure.cap);
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

// ---------------------------------------------------------------------------
// POST /v1/blobs/:id/tokens — mint a /b/<token> capability URL.
//
// Body (JSON, optional):
//   { ttl_seconds?: number, once?: boolean }
//
// TTL defaults per scope:
//   - session-scope:  matches the session's expiresAt (cascades on session delete)
//   - agent-scope:    BLOB_TOKEN_TTL_AGENT_SECONDS (24h default)
//   - artifact-scope: BLOB_TOKEN_TTL_ARTIFACT_SECONDS (30d default)
//
// `ttl_seconds` overrides the default within a per-scope upper bound (the
// default; you can shorten, never lengthen — protects against operators
// being talked into a "just-this-once" override that becomes the norm).
// `once = true` makes the resulting token self-delete on first successful GET.
//
// Returns: { token, url, expires_at, once, token_id }. The full `token` is
// only ever returned once, here — subsequent reads see only the prefix.
// ---------------------------------------------------------------------------
blobs.post("/:id/tokens", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const me = c.get("agent");

  const id = c.req.param("id");
  const blob = await prisma.blob.findUnique({ where: { id } });
  if (!blob || blob.ownerId !== me.id || blob.status === "deleted") {
    throw errors.blobNotFound();
  }
  if (blob.status !== "ready") throw errors.blobNotFound();

  const body = (await c.req.json().catch(() => ({}))) as {
    ttl_seconds?: unknown;
    once?: unknown;
  };
  const once = body.once === true;

  // Compute default TTL by scope, then accept a caller-supplied shorter TTL
  // (never longer — the per-scope default is the ceiling).
  const expiresAt = await computeTokenExpiry(
    prisma,
    blob,
    config,
    body.ttl_seconds,
  );

  const minted = generateBlobToken();
  const tokenRow = await prisma.blobToken.create({
    data: {
      blobId: blob.id,
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
// DELETE /v1/blobs/:id/tokens/:token_id — revoke a token.
//
// Idempotent: revoking an already-revoked or expired token returns the same
// shape. Adds the token's hash to the in-memory revoke cache so subsequent
// /b/<token> requests short-circuit without a DB read.
// ---------------------------------------------------------------------------
blobs.delete("/:id/tokens/:token_id", async (c) => {
  const prisma = c.get("prisma");
  const cache = c.get("blobRevokeCache");
  const me = c.get("agent");

  const blobId = c.req.param("id");
  const tokenId = c.req.param("token_id");

  // Verify the agent owns the parent blob — otherwise we'd leak that a
  // token id exists for someone else's blob via the 404 vs. 200 channel.
  const blob = await prisma.blob.findUnique({
    where: { id: blobId },
    select: { ownerId: true },
  });
  if (!blob || blob.ownerId !== me.id) throw errors.blobNotFound();

  const tok = await prisma.blobToken.findUnique({
    where: { id: tokenId },
    select: { id: true, blobId: true, tokenHash: true, revokedAt: true },
  });
  if (!tok || tok.blobId !== blobId) throw errors.blobTokenNotFound();

  if (tok.revokedAt) {
    // Already revoked — return the idempotent shape.
    cache?.add(tok.tokenHash);
    return c.json({ token_id: tok.id, revoked: true });
  }

  await prisma.blobToken.update({
    where: { id: tok.id },
    data: { revokedAt: new Date() },
  });
  cache?.add(tok.tokenHash);
  return c.json({ token_id: tok.id, revoked: true });
});

// ===========================================================================
// Helpers — kept private to this module so the route file stays the entire
// surface for /v1/blobs.
// ===========================================================================

/**
 * Parse the `scope` form field. Empty / missing defaults to `agent`. Anything
 * outside the enum is rejected as `invalid_request`.
 */
function parseScope(raw: unknown): "agent" | "session" | "artifact" {
  if (raw === undefined || raw === null || raw === "") return "agent";
  if (raw === "agent" || raw === "session" || raw === "artifact") return raw;
  throw errors.invalidRequest(
    `unknown scope='${String(raw)}'`,
    { scope: String(raw), supported: ["agent", "session", "artifact"] },
    "pass scope=agent|session|artifact; session-scope requires session_id, artifact-scope requires artifact_id",
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
  scope: "agent" | "session" | "artifact";
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
    sessionId: string | null;
    artifactId: string | null;
    config: Config;
    /**
     * Bytes that have been written to the BlobStore but whose Blob row
     * still carries the placeholder `size: 0`. The route adds these into
     * the aggregate so the just-written blob is counted before the commit
     * UPDATE lands.
     */
    extraBytes: number;
  },
): Promise<QuotaFailure | null> {
  const { ownerId, sessionId, artifactId, config, extraBytes } = opts;

  // Per-agent — always applies.
  const agentAgg = await prisma.blob.aggregate({
    where: { ownerId, status: { in: ["pending", "ready"] } },
    _sum: { size: true },
  });
  if (
    (agentAgg._sum.size ?? 0) + extraBytes >
    config.MAX_BLOBS_PER_AGENT_BYTES
  ) {
    return { scope: "agent", cap: config.MAX_BLOBS_PER_AGENT_BYTES };
  }

  if (sessionId) {
    const ses = await prisma.blob.aggregate({
      where: { sessionId, status: { in: ["pending", "ready"] } },
      _sum: { size: true },
    });
    if (
      (ses._sum.size ?? 0) + extraBytes >
      config.MAX_BLOBS_PER_SESSION_BYTES
    ) {
      return { scope: "session", cap: config.MAX_BLOBS_PER_SESSION_BYTES };
    }
  }

  if (artifactId) {
    const art = await prisma.blob.aggregate({
      where: { artifactId, status: { in: ["pending", "ready"] } },
      _sum: { size: true },
    });
    if (
      (art._sum.size ?? 0) + extraBytes >
      config.MAX_BLOBS_PER_ARTIFACT_BYTES
    ) {
      return { scope: "artifact", cap: config.MAX_BLOBS_PER_ARTIFACT_BYTES };
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
  blob: { scope: string; sessionId: string | null },
  config: Config,
  ttlSecondsRaw: unknown,
): Promise<Date> {
  const now = Date.now();
  let defaultExpiry: Date;

  if (blob.scope === "session") {
    if (!blob.sessionId) {
      // Shouldn't happen — session-scope blobs always have sessionId set —
      // but be defensive.
      throw errors.invalidRequest(
        "session-scope blob is missing session_id (data integrity issue)",
      );
    }
    const ses = await prisma.session.findUnique({
      where: { id: blob.sessionId },
      select: { expiresAt: true },
    });
    if (!ses) {
      // The cascade would normally take the blob with the session; if we're
      // still here the row is racing the deletion. Treat as a not-found.
      throw errors.blobNotFound();
    }
    defaultExpiry = ses.expiresAt;
  } else if (blob.scope === "artifact") {
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

export default blobs;
