// Shared multipart-blob upload pipeline.
//
// Extracted from `POST /v1/blobs` so the participant-side upload route
// (`POST /s/:participantToken/blobs`, follow-up C of #156) can run the EXACT
// same downstream pipeline without forking the logic:
//   1. MIME sniff (sniffed wins over declared Content-Type)
//   2. Polyglot defense + EXIF strip via sharp (`normaliseImage`)
//   3. Envelope encryption-at-rest (when BLOB_ENCRYPT_AT_REST=true)
//   4. BlobStore write + integrity cross-check
//   5. Aggregate quota enforcement (+ optional LRU eviction)
//   6. Optional scan webhook
//   7. Commit: status=ready, confirmedAt=now
//
// Callers parse the multipart envelope themselves (so each route can map
// missing fields to its own preferred error code + hint) and hand a
// `BlobUploadInput` to `processBlobUpload`.
//
// The `ownerId` carried in the input is the AGENT id, even for the
// participant-side route — human uploads count against the agent that owns
// the session, never against the participant.
//
// Quota helpers (`enforceQuotas`) live alongside the route in
// `src/http/routes/blobs.ts` for now. The pipeline reaches in via a
// callback so callers stay in control of scope-validation + cross-tenant
// checks, and so a future split of those concerns doesn't require touching
// this module.

import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import { errors } from "../http/errors.js";
import {
  BlobIntegrityError,
  BlobSizeExceededError,
  generateBlobToken,
  hashBlobToken,
  ImageNormalisationError,
  isMimeAllowed,
  isNormalisable,
  normaliseImage,
  sniffMime,
  type BlobStore,
} from "./index.js";

/** Maps a blob id → opaque storage key. Kept here so the bridge + /v1 agree. */
export function storageKeyFor(blobId: string): string {
  return `blob_${blobId}`;
}

export interface BlobUploadInput {
  /** The owning agent id. For session-scope uploads from a participant this
   * is `session.agentId` — the participant is NOT the owner. */
  ownerId: string;
  /** Already-validated scope (caller is responsible for cross-tenant + FK
   * existence checks, and for forcing scope="session" on participant routes). */
  scope: "agent" | "session" | "artifact";
  /** Required when scope="session". Caller has already verified the agent
   * owns this session (or, for participant routes, that the token's session
   * matches). */
  sessionId: string | null;
  /** Required when scope="artifact". */
  artifactId: string | null;
  /** Optional UX-only display name (no security meaning — sanitised at
   * download time by Content-Disposition rules). */
  filename: string | null;
  /** The raw multipart File. Read once via .stream(). */
  file: File;
}

export interface QuotaEnforcer {
  /**
   * Run the aggregate-quota check after bytes have been written. Returns
   * null when every cap is satisfied or a `{scope, cap}` describing the
   * first failure. The pipeline rolls back (delete bytes + mark row failed)
   * on a failure result.
   *
   * The pipeline passes `extraBytes` = the size of the freshly-written blob
   * (already on disk but not yet committed to its row) so the caller's
   * quota helper can include it in the aggregate.
   */
  enforce(opts: {
    ownerId: string;
    sessionId: string | null;
    artifactId: string | null;
    extraBytes: number;
  }): Promise<{ scope: "agent" | "session" | "artifact"; cap: number } | null>;
}

export interface BlobRowReady {
  id: string;
  ownerId: string;
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
  storageKey: string;
  createdAt: Date;
  confirmedAt: Date | null;
  deletedAt: Date | null;
  encryptionEnvelope: string | null;
}

export interface ProcessBlobUploadDeps {
  prisma: PrismaClient;
  config: Config;
  store: BlobStore;
  quota: QuotaEnforcer;
}

/**
 * Run a multipart-blob upload through the full pipeline and return the
 * committed `Blob` row. Throws an `ApiError` (via `errors.*`) on every
 * client-visible failure — callers re-throw and the global Hono handler
 * serialises it. On a transient failure mid-stream the just-created row is
 * marked `failed` (no rollback transactions; the orphan-sweep job cleans
 * the storage backend).
 */
export async function processBlobUpload(
  deps: ProcessBlobUploadDeps,
  input: BlobUploadInput,
): Promise<BlobRowReady> {
  const { prisma, config, store, quota } = deps;
  const { ownerId, scope, sessionId, artifactId, filename, file } = input;

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

  // Drain the rest of the same reader so we have the full upload as a
  // Buffer. MAX_BLOB_BYTES caps this at 5 MB by default — well within
  // Node's comfort zone. The cap is enforced as we read, before any
  // allocation becomes hostile.
  const uploaded = await drainReaderToBuffer(
    firstChunk,
    reader,
    streamDone,
    config.MAX_BLOB_BYTES,
  ).catch((e) => {
    if (e instanceof BlobSizeExceededError) {
      throw errors.blobSizeExceeded(config.MAX_BLOB_BYTES);
    }
    throw e;
  });

  // Normalise images: decode + re-encode via sharp, dropping appended
  // polyglot payloads and stripping metadata (EXIF / IPTC / XMP /
  // embedded thumbnail). Non-image MIMEs pass through unchanged. sharp
  // throws on anything that doesn't decode — which is the right signal
  // for a hostile polyglot (the format-sniff layer let it through, but
  // it's not a valid image).
  let finalBytes: Buffer;
  let finalSha256: string;
  let finalSize: number;
  let width: number | null = null;
  let height: number | null = null;
  try {
    if (isNormalisable(sniffedMime)) {
      const normalised = await normaliseImage({
        bytes: uploaded,
        mime: sniffedMime,
        stripMetadata: true,
      });
      finalBytes = normalised.bytes;
      finalSha256 = normalised.sha256;
      finalSize = normalised.bytes.length;
      width = normalised.width ?? null;
      height = normalised.height ?? null;
    } else {
      // Pass-through (SVG, PDF). Still hash + size from the bytes we
      // already have so the rest of the pipeline doesn't care.
      finalBytes = uploaded;
      finalSha256 = createHash("sha256").update(uploaded).digest("hex");
      finalSize = uploaded.length;
    }
  } catch (e) {
    if (e instanceof ImageNormalisationError) {
      throw errors.mimeDisallowed(sniffedMime, config.BLOB_MIME_ALLOWLIST);
    }
    throw e;
  }

  // Envelope encryption-at-rest (opt-in). When BLOB_ENCRYPT_AT_REST=true,
  // we encrypt the normalised plaintext with a fresh per-blob DEK; the
  // bytes stored in the BlobStore are ciphertext, and the DB row carries
  // the wrapped DEK + data IV + tag in `encryptionEnvelope` for the GET
  // path to decrypt. The Blob row's `size` + `sha256` ALWAYS reflect the
  // PLAINTEXT — those are user-facing values; the ciphertext sha256 is
  // an internal storage detail tracked via the integrity check below.
  let bytesForStore: Buffer = finalBytes;
  let encryptionEnvelope: string | null = null;
  let ciphertextSha256 = finalSha256;
  let ciphertextSize = finalSize;
  if (config.BLOB_ENCRYPT_AT_REST) {
    const { encryptBlob, serialiseEnvelope } = await import("./encrypt.js");
    const { getMasterKey } = await import("../crypto.js");
    const enc = encryptBlob(finalBytes, getMasterKey());
    bytesForStore = enc.ciphertext;
    encryptionEnvelope = serialiseEnvelope(enc.envelope);
    ciphertextSha256 = createHash("sha256").update(bytesForStore).digest("hex");
    ciphertextSize = bytesForStore.length;
  }

  // Create the blob row first (status=pending) so we have an id to derive
  // the storage key from. If the upload fails after this point, we mark
  // the row failed (a janitor task in a later PR sweeps these).
  const row = await prisma.blob.create({
    data: {
      ownerId,
      scope,
      sessionId,
      artifactId,
      mime: sniffedMime,
      size: finalSize,
      sha256: finalSha256,
      width,
      height,
      filename,
      storageKey: "", // placeholder, set on the same row after we know the id
      status: "pending",
      encryptionEnvelope,
    },
  });
  const storageKey = storageKeyFor(row.id);
  await prisma.blob.update({
    where: { id: row.id },
    data: { storageKey },
  });

  // Stream into the BlobStore. The store recomputes sha256 + size as it
  // writes; we cross-check the CIPHERTEXT values below (which are the same
  // as the plaintext values when encryption is off).
  let info;
  try {
    info = await store.put(storageKey, Readable.from(bytesForStore), {
      mime: sniffedMime,
      maxBytes: config.MAX_BLOB_BYTES,
    });
  } catch (e) {
    await prisma.blob
      .update({ where: { id: row.id }, data: { status: "failed" } })
      .catch(() => {
        /* best-effort */
      });

    if (e instanceof BlobSizeExceededError) {
      throw errors.blobSizeExceeded(config.MAX_BLOB_BYTES);
    }
    if (e instanceof BlobIntegrityError) {
      throw errors.invalidRequest(
        "internal integrity check failed — storage backend hash/size disagrees",
      );
    }
    throw e;
  }

  // Sanity check: the backend's computed sha256 must match the ciphertext
  // sha256 we computed before the store.put. A mismatch here means a
  // backend bug or storage corruption — refuse the upload loudly.
  if (info.sha256 !== ciphertextSha256 || info.size !== ciphertextSize) {
    await store.delete(storageKey).catch(() => {
      /* best-effort */
    });
    await prisma.blob.update({
      where: { id: row.id },
      data: { status: "failed" },
    });
    throw errors.invalidRequest(
      "internal integrity check failed — storage backend hash/size disagrees",
    );
  }

  // Aggregate quotas. The per-agent cap applies to EVERY scope (an
  // agent's total footprint across all blobs they own). The per-session
  // or per-artifact cap applies on top of that when relevant. The just-
  // written row still has its placeholder `size: 0` at this point, so
  // we add `info.size` into the aggregate via `extraBytes`.
  const quotaFailure = await quota.enforce({
    ownerId,
    sessionId,
    artifactId,
    extraBytes: info.size,
  });
  if (quotaFailure) {
    await store.delete(storageKey).catch(() => {
      /* best-effort */
    });
    await prisma.blob.update({
      where: { id: row.id },
      data: { status: "failed" },
    });
    throw errors.quotaExceeded(quotaFailure.scope, quotaFailure.cap);
  }

  // Optional scan-hook step. When BLOB_SCAN_HOOK is set, POST the blob's
  // metadata to the scanner and wait for a verdict before flipping the
  // row to ready. Fail-closed: any throw (timeout, non-2xx, bad
  // signature, "infected" verdict) results in the blob being deleted.
  if (config.BLOB_SCAN_HOOK) {
    try {
      const { callScanHook } = await import("./scan-hook.js");
      // Mint a single-use scan token (5-minute TTL, `once=true`). The
      // scanner GETs the blob bytes via this URL — no agent key needed.
      const tok = generateBlobToken();
      await prisma.blobToken.create({
        data: {
          blobId: row.id,
          tokenHash: tok.hash,
          tokenPrefix: tok.prefix,
          expiresAt: new Date(Date.now() + 5 * 60_000),
          once: true,
        },
      });
      // Reference to suppress "unused import" warning when call is mocked.
      void hashBlobToken;
      const downloadUrl = `${(config.publicUrl ?? "").replace(/\/$/, "")}/b/${tok.token}`;
      const verdict = await callScanHook(
        config,
        {
          blob_id: row.id,
          scope: scope,
          mime: sniffedMime,
          size: finalSize,
          sha256: finalSha256,
          download_url: downloadUrl,
        },
        { timeoutMs: config.BLOB_SCAN_TIMEOUT_MS },
      );
      if (verdict.verdict !== "clean") {
        throw new Error(
          `scan returned verdict=${verdict.verdict}${
            verdict.reason ? ` (${verdict.reason})` : ""
          }`,
        );
      }
    } catch (e) {
      await store.delete(storageKey).catch(() => {
        /* best-effort */
      });
      await prisma.blob.update({
        where: { id: row.id },
        data: { status: "failed" },
      });
      throw errors.invalidRequest(
        "blob failed virus / content scan",
        undefined,
        e instanceof Error
          ? `scanner reported: ${e.message}`
          : "scanner rejected the upload",
      );
    }
  }

  // Commit: mark ready. size/sha256 stay as the PLAINTEXT values written
  // at create time — when encryption-at-rest is on, the ciphertext
  // size/sha256 from `info` are only used for the integrity check above.
  const final = await prisma.blob.update({
    where: { id: row.id },
    data: {
      status: "ready",
      confirmedAt: new Date(),
    },
  });

  return final as BlobRowReady;
}

/**
 * Drain a Web ReadableStreamDefaultReader (whose first chunk has already
 * been pulled for MIME sniffing) into one contiguous Buffer. Enforces
 * `maxBytes` mid-stream by tracking the running total; throws
 * `BlobSizeExceededError` and releases the reader lock if the cap is
 * exceeded.
 *
 * The whole upload is buffered because the polyglot-normalisation pass
 * (sharp) operates on a complete image — there's no useful "streaming
 * normalisation" mode in libvips for our use case. MAX_BLOB_BYTES caps
 * this at 5 MB so the memory cost is bounded.
 */
async function drainReaderToBuffer(
  firstChunk: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  alreadyDone: boolean,
  maxBytes: number,
): Promise<Buffer> {
  let observed = firstChunk.length;
  if (observed > maxBytes) {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    throw new BlobSizeExceededError(maxBytes, observed);
  }

  const chunks: Buffer[] = [Buffer.from(firstChunk)];
  if (alreadyDone) {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
    return Buffer.concat(chunks);
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        observed += value.length;
        if (observed > maxBytes) {
          throw new BlobSizeExceededError(maxBytes, observed);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return Buffer.concat(chunks);
}
