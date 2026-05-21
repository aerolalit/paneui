-- Blobs: binary attachments owned by an agent, scoped to either:
--   * "agent"    — reusable across the agent's sessions (session_id + artifact_id both NULL)
--   * "session"  — bound to one session (session_id set, artifact_id NULL); cascades on session delete
--   * "artifact" — bound to one reusable artifact (artifact_id set, session_id NULL); cascades on artifact delete
--
-- The scope column is the source of truth and the application layer enforces
-- the "exactly one of (session_id set, artifact_id set, neither set)" invariant
-- (no cross-column check constraint in sqlite). owner_id is the authz anchor.
--
-- Bytes themselves live in the configured BlobStore (filesystem self-host,
-- Azure Blob hosted). storage_key is opaque and never used as a path
-- component — it's an identifier the backend maps to a real location.
--
-- status:
--   "pending"  — upload presigned but not confirmed
--   "ready"    — confirmed + HEAD-verified
--   "failed"   — upload or scan failed; metadata kept for audit
--   "deleted"  — soft-deleted; bytes already removed from BlobStore
CREATE TABLE "blobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "session_id" TEXT,
  "artifact_id" TEXT,
  "mime" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "storage_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "filename" TEXT,
  "strip_metadata" BOOLEAN NOT NULL DEFAULT true,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_at" DATETIME,
  "deleted_at" DATETIME,
  CONSTRAINT "blobs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "blobs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "blobs_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "blobs_storage_key_key" ON "blobs"("storage_key");
CREATE INDEX "blobs_owner_id_idx" ON "blobs"("owner_id");
CREATE INDEX "blobs_scope_owner_id_idx" ON "blobs"("scope", "owner_id");
CREATE INDEX "blobs_session_id_idx" ON "blobs"("session_id");
CREATE INDEX "blobs_artifact_id_idx" ON "blobs"("artifact_id");
