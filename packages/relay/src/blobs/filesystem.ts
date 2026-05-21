// FilesystemBlobStore — zero-config self-host backend.
//
// Single-VM only. Files live under `dir` with mode 0600; the directory itself
// is checked at startup and refused if world-readable (mode & 0o007 !== 0).
// Bytes are written via temp-file + atomic rename so a crash mid-write can't
// leave a partial blob at the final key.
//
// sha256 is computed on the fly during the streaming write (no buffer the
// full payload in memory). The size + sha256 are persisted in a sidecar
// `.meta.json` next to the blob so `head()` is a cheap stat+read without
// re-hashing the bytes. The sidecar is the source of truth for size + sha256
// after write completes; if the sidecar and the real file disagree, that's a
// corruption the TOCTOU check at confirm-time will surface.
//
// Self-host caveats — documented at startup:
//   * No multi-replica support (no cross-VM coordination). Use Azure Blob
//     for multi-replica deployments.
//   * `dir` MUST be on a filesystem the relay's process can `fsync` (some
//     network filesystems silently no-op fsync, which weakens durability).

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  promises as fs,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  BlobIntegrityError,
  BlobSizeExceededError,
  type BlobObjectInfo,
  type BlobStore,
  type WriteOpts,
} from "./store.js";

interface SidecarMeta {
  size: number;
  sha256: string;
  mime?: string;
}

export interface FilesystemBlobStoreOpts {
  /**
   * Absolute or relative directory the backend writes blobs under. Created
   * (recursive, mode 0700) at startup if missing. Pre-existing directories
   * are checked: refused if mode & 0o007 !== 0 (world-readable).
   */
  dir: string;
}

export class FilesystemBlobStore implements BlobStore {
  private readonly dir: string;

  constructor(opts: FilesystemBlobStoreOpts) {
    this.dir = resolve(opts.dir);
  }

  /**
   * Verify the storage directory exists, create it if missing, and refuse to
   * start if its mode is world-readable. Call this once at relay boot before
   * accepting traffic — keeps the security check off the hot path.
   */
  async init(): Promise<void> {
    let st;
    try {
      st = statSync(this.dir);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
      // Doesn't exist — create it 0700.
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      return;
    }

    if (!st.isDirectory()) {
      throw new Error(
        `BLOB_STORE_FS_DIR=${this.dir} exists but is not a directory`,
      );
    }
    // Refuse world-readable. & 0o007 isolates the "other" permission bits.
    if ((st.mode & 0o007) !== 0) {
      throw new Error(
        `BLOB_STORE_FS_DIR=${this.dir} is world-readable (mode 0o${(st.mode & 0o777).toString(8)}); refusing to start. Run \`chmod o-rwx ${this.dir}\``,
      );
    }
  }

  /**
   * Stream `body` to `<dir>/<key>.tmp` while hashing + counting bytes; if the
   * stream exceeds `opts.maxBytes` we cut it and delete the temp file.
   * On success, atomically renames into place and writes the sidecar metadata.
   *
   * Returns the verified size + sha256 the file actually contains.
   */
  async put(
    key: string,
    body: Readable,
    opts: WriteOpts,
  ): Promise<BlobObjectInfo> {
    const finalPath = this.pathFor(key);
    const tmpPath = finalPath + ".tmp";
    const sidecarPath = finalPath + ".meta.json";

    const hasher = createHash("sha256");
    let observed = 0;
    let cutForSize = false;

    // Tap the body to count + hash + enforce cap; pipeline handles
    // backpressure for us.
    const tap = new (await import("node:stream")).Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (cutForSize) return cb();
        observed += chunk.length;
        if (observed > opts.maxBytes) {
          cutForSize = true;
          return cb(new BlobSizeExceededError(opts.maxBytes, observed));
        }
        hasher.update(chunk);
        cb(null, chunk);
      },
    });

    const writer = createWriteStream(tmpPath, { mode: 0o600, flags: "wx" });
    try {
      await pipeline(body, tap, writer);
    } catch (e) {
      // Clean up the temp file regardless of why we failed.
      await fs.rm(tmpPath, { force: true });
      throw e;
    }

    const sha256 = hasher.digest("hex");
    const info: SidecarMeta = { size: observed, sha256, mime: opts.mime };

    // Commit: rename tmp → final, then write the sidecar. If the sidecar
    // write fails after the rename, the blob exists without metadata — a
    // later head() returns null (no sidecar = pretend it's not there), and
    // the route layer's confirm step rejects with BlobIntegrityError.
    await fs.rename(tmpPath, finalPath);
    await fs.writeFile(sidecarPath, JSON.stringify(info), { mode: 0o600 });
    return info;
  }

  async get(key: string): Promise<Readable | null> {
    const p = this.pathFor(key);
    try {
      // statSync first so we don't open a stream against a missing file
      // (which would emit an error on read rather than letting the caller
      // distinguish "not found" cleanly).
      statSync(p);
    } catch {
      return null;
    }
    return createReadStream(p);
  }

  async head(key: string): Promise<BlobObjectInfo | null> {
    const sidecarPath = this.pathFor(key) + ".meta.json";
    let raw: string;
    try {
      raw = await fs.readFile(sidecarPath, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      throw err;
    }
    let parsed: SidecarMeta;
    try {
      parsed = JSON.parse(raw) as SidecarMeta;
    } catch {
      // Corrupt sidecar — treat as missing so the caller's TOCTOU check
      // fails loudly rather than returning bogus metadata.
      return null;
    }

    // Cross-check against the real file's size. If they disagree, the bytes
    // were tampered with after commit; refuse to claim integrity.
    try {
      const st = await fs.stat(this.pathFor(key));
      if (st.size !== parsed.size) {
        throw new BlobIntegrityError(
          { size: parsed.size, sha256: parsed.sha256 },
          { size: st.size, sha256: "<not recomputed>" },
        );
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      throw e;
    }

    return { size: parsed.size, sha256: parsed.sha256, mime: parsed.mime };
  }

  async delete(key: string): Promise<void> {
    const p = this.pathFor(key);
    await fs.rm(p, { force: true });
    await fs.rm(p + ".meta.json", { force: true });
  }

  /**
   * Map a storage key to an absolute filesystem path. The key is treated as
   * opaque — `join` collapses any traversal attempts, and the route layer
   * has already enforced that `key` matches `blob_<cuid>` (no separators).
   */
  private pathFor(key: string): string {
    return join(this.dir, key);
  }
}
