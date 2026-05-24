// AttachmentStore — backend-agnostic interface for the bytes side of a attachment.
//
// The relay code (route handlers, scope checks, authz) is identical across
// backends; only the bytes-on-storage call shape differs. v0.1.0 ships two
// implementations:
//
//   * FilesystemBlobStore — self-host default. Single-VM only (no shared FS
//     contract). Stores under BLOB_STORE_FS_DIR with 0600 mode and atomic
//     rename for the commit step.
//
//   * AzureBlobStore — hosted relay. Uses @azure/storage-blob with managed
//     identity (DefaultAzureCredential) and SAS for presigned upload URLs.
//     Lands in PR #3 of the attachment stack — interface is shaped to fit ahead of
//     time so the route layer doesn't change.
//
// Other backends (S3, R2, GCS) are not in v0.1.0 scope but the interface is
// the seam that lets them land later behind the same route code.
//
// Methods deliberately use a generic `key: string` (the relay-owned storage
// key, e.g. `attachment_<id>`) — backends are responsible for mapping that into
// whatever native location their storage system uses (a path under
// BLOB_STORE_FS_DIR, a attachment-name in an Azure container, an S3 object key).

import type { Readable } from "node:stream";

/**
 * Metadata the AttachmentStore observes about a stored object — populated by HEAD
 * or returned from a write. Used by the TOCTOU defence to compare what the
 * backend actually persisted against what was committed at upload time.
 */
export interface AttachmentObjectInfo {
  size: number;
  /** Hex-encoded sha256. Computed during write and round-tripped via the
   * backend's custom-metadata facility (e.g. Azure `x-ms-meta-sha256`). */
  sha256: string;
  mime?: string;
}

/**
 * Options for the relay-proxied write path (used by `POST /v1/attachments` multipart
 * in v0.1.0). Streams the body to the backend; computes sha256 and total size
 * as it goes; rejects with `attachment_size_exceeded` if total exceeds `maxBytes`.
 */
export interface WriteOpts {
  mime: string;
  maxBytes: number;
}

export interface AttachmentStore {
  /**
   * Stream `body` into the backend at `key`, capped at `opts.maxBytes`.
   *
   * The backend computes sha256 as the bytes go through (one pass — no buffer
   * the full payload into memory) and stores it alongside the bytes so a
   * later `head()` can return it without recomputing. Returns the verified
   * size and sha256 the backend actually persisted; the caller compares
   * against any client-asserted values as part of the TOCTOU defence.
   *
   * Throws `AttachmentSizeExceededError` if the streamed body would exceed
   * `opts.maxBytes` (cuts the stream and discards any partial write).
   */
  put(
    key: string,
    body: Readable,
    opts: WriteOpts,
  ): Promise<AttachmentObjectInfo>;

  /**
   * Stream the bytes at `key` back to the caller. Returns null if no object
   * exists at that key (the route layer turns this into a 404).
   *
   * The returned stream is the caller's responsibility to consume or destroy;
   * the backend doesn't time it out (caller's HTTP response handles that).
   */
  get(key: string): Promise<Readable | null>;

  /**
   * Return the backend's observed metadata for `key`, or null if not present.
   * The size + sha256 fields are read from the backend's native source of
   * truth (filesystem stat + sidecar metadata; Azure HEAD with custom-metadata
   * headers). Never trust client-supplied values here.
   */
  head(key: string): Promise<AttachmentObjectInfo | null>;

  /**
   * Remove the bytes at `key`. Idempotent — deleting a missing key is a
   * no-op success. The attachment row's `deletedAt` is updated separately by the
   * route layer; this only handles the storage side.
   */
  delete(key: string): Promise<void>;
}

/**
 * Thrown by `put()` when the streamed body exceeds the per-attachment byte cap.
 * Distinct error type so the route layer can map it to the `attachment_size_exceeded`
 * error envelope without sniffing message strings.
 */
export class AttachmentSizeExceededError extends Error {
  constructor(
    public readonly maxBytes: number,
    public readonly observed: number,
  ) {
    super(
      `attachment upload exceeded ${maxBytes} bytes (saw ≥ ${observed} bytes before cutting the stream)`,
    );
    this.name = "AttachmentSizeExceededError";
  }
}

/**
 * Thrown by backend implementations when they detect the bytes on storage
 * don't match what was committed at upload time (size mismatch, sha256
 * mismatch). The TOCTOU defence at confirm-time catches this.
 */
export class AttachmentIntegrityError extends Error {
  constructor(
    public readonly expected: { size: number; sha256: string },
    public readonly observed: { size: number; sha256: string },
  ) {
    super(
      `attachment bytes don't match commitment: expected size=${expected.size} sha256=${expected.sha256}, observed size=${observed.size} sha256=${observed.sha256}`,
    );
    this.name = "AttachmentIntegrityError";
  }
}
