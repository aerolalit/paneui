-- Surface → Pane rename. See docs/NAMING-PROPOSAL.md for the rationale.
-- Tables, columns, and indexes all move to the new vocabulary; no compat
-- shims (pre-1.0, only consumer is this repo).
--
-- SQLite ≥ 3.25 atomically updates FK definitions when a referenced
-- table or column is renamed via ALTER TABLE … RENAME …, so we don't have
-- to rebuild every dependent table.

-- 1. Rename the two tables that change name.
ALTER TABLE "surfaces" RENAME TO "panes";
ALTER TABLE "surface_records" RENAME TO "pane_records";

-- 2. Rename the FK columns. (Index names that include the old column name
--    are recreated below — sqlite keeps the indexes but their names get
--    out of sync with the Prisma naming convention until we drop+create.)
ALTER TABLE "events" RENAME COLUMN "surface_id" TO "pane_id";
ALTER TABLE "participants" RENAME COLUMN "surface_id" TO "pane_id";
ALTER TABLE "feedback" RENAME COLUMN "surface_id" TO "pane_id";
ALTER TABLE "attachments" RENAME COLUMN "surface_id" TO "pane_id";
ALTER TABLE "record_collections" RENAME COLUMN "surface_id" TO "pane_id";

-- 3. Recreate every index whose name embeds the old column / table name so
--    it matches the convention Prisma will emit on the next migration.
DROP INDEX IF EXISTS "events_surface_id_id_idx";
DROP INDEX IF EXISTS "events_surface_id_author_id_idempotency_key_key";
CREATE INDEX "events_pane_id_id_idx" ON "events"("pane_id", "id");
CREATE UNIQUE INDEX "events_pane_id_author_id_idempotency_key_key" ON "events"("pane_id", "author_id", "idempotency_key");

DROP INDEX IF EXISTS "participants_surface_id_idx";
CREATE INDEX "participants_pane_id_idx" ON "participants"("pane_id");
DROP INDEX IF EXISTS "participants_surface_id_identity_id_key";
CREATE UNIQUE INDEX "participants_pane_id_identity_id_key" ON "participants"("pane_id", "identity_id");

DROP INDEX IF EXISTS "attachments_surface_id_idx";
CREATE INDEX "attachments_pane_id_idx" ON "attachments"("pane_id");

DROP INDEX IF EXISTS "record_collections_surface_id_name_key";
CREATE UNIQUE INDEX "record_collections_pane_id_name_key" ON "record_collections"("pane_id", "name");

DROP INDEX IF EXISTS "surface_records_collection_id_seq_idx";
DROP INDEX IF EXISTS "surface_records_collection_id_record_key_key";
CREATE INDEX "pane_records_collection_id_seq_idx" ON "pane_records"("collection_id", "seq");
CREATE UNIQUE INDEX "pane_records_collection_id_record_key_key" ON "pane_records"("collection_id", "record_key");

-- 4. Indexes that lived ON the surfaces table itself follow the table rename
--    automatically (sqlite keeps them attached) but their names still embed
--    "surfaces" — recreate them under the new naming.
DROP INDEX IF EXISTS "surfaces_agent_id_idx";
DROP INDEX IF EXISTS "surfaces_expires_at_idx";
DROP INDEX IF EXISTS "surfaces_template_version_id_idx";
DROP INDEX IF EXISTS "surfaces_owner_human_id_idx";
DROP INDEX IF EXISTS "Surface_owner_dedup";
CREATE INDEX "panes_agent_id_idx" ON "panes"("agent_id");
CREATE INDEX "panes_expires_at_idx" ON "panes"("expires_at");
CREATE INDEX "panes_template_version_id_idx" ON "panes"("template_version_id");
CREATE INDEX "panes_owner_human_id_idx" ON "panes"("owner_human_id");
CREATE UNIQUE INDEX "Pane_owner_dedup" ON "panes"("template_version_id", "owner_human_id", "context_key");
