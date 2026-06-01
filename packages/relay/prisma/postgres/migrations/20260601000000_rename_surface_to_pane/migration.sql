-- Surface → Pane rename (postgres). See docs/NAMING-PROPOSAL.md.
-- Postgres preserves FK references through table + column renames, but FK
-- and index *names* don't auto-update, so we rename them explicitly to keep
-- the schema in step with Prisma's naming convention.

-- 1. Rename the two tables that change name.
ALTER TABLE "surfaces" RENAME TO "panes";
ALTER TABLE "surface_records" RENAME TO "pane_records";

-- 2. Rename FK columns. FK constraints follow the column automatically.
ALTER TABLE "events" RENAME COLUMN "surface_id" TO "pane_id";
ALTER TABLE "participants" RENAME COLUMN "surface_id" TO "pane_id";
ALTER TABLE "feedback" RENAME COLUMN "surface_id" TO "pane_id";
ALTER TABLE "attachments" RENAME COLUMN "surface_id" TO "pane_id";
ALTER TABLE "record_collections" RENAME COLUMN "surface_id" TO "pane_id";

-- 3. Rename indexes to match the new column / table convention.
ALTER INDEX "events_surface_id_id_idx" RENAME TO "events_pane_id_id_idx";
ALTER INDEX "events_surface_id_author_id_idempotency_key_key" RENAME TO "events_pane_id_author_id_idempotency_key_key";
ALTER INDEX "participants_surface_id_idx" RENAME TO "participants_pane_id_idx";
ALTER INDEX "participants_surface_id_identity_id_key" RENAME TO "participants_pane_id_identity_id_key";
ALTER INDEX "attachments_surface_id_idx" RENAME TO "attachments_pane_id_idx";
ALTER INDEX "record_collections_surface_id_name_key" RENAME TO "record_collections_pane_id_name_key";
ALTER INDEX "surface_records_collection_id_seq_idx" RENAME TO "pane_records_collection_id_seq_idx";
ALTER INDEX "surface_records_collection_id_record_key_key" RENAME TO "pane_records_collection_id_record_key_key";
ALTER INDEX "surfaces_agent_id_idx" RENAME TO "panes_agent_id_idx";
ALTER INDEX "surfaces_expires_at_idx" RENAME TO "panes_expires_at_idx";
ALTER INDEX "surfaces_template_version_id_idx" RENAME TO "panes_template_version_id_idx";
ALTER INDEX "surfaces_owner_human_id_idx" RENAME TO "panes_owner_human_id_idx";
ALTER INDEX "Surface_owner_dedup" RENAME TO "Pane_owner_dedup";

-- 4. Rename FK constraints to match Prisma's <table>_<col>_fkey convention.
ALTER TABLE "events" RENAME CONSTRAINT "events_surface_id_fkey" TO "events_pane_id_fkey";
ALTER TABLE "participants" RENAME CONSTRAINT "participants_surface_id_fkey" TO "participants_pane_id_fkey";
ALTER TABLE "feedback" RENAME CONSTRAINT "feedback_surface_id_fkey" TO "feedback_pane_id_fkey";
ALTER TABLE "attachments" RENAME CONSTRAINT "attachments_surface_id_fkey" TO "attachments_pane_id_fkey";
ALTER TABLE "record_collections" RENAME CONSTRAINT "record_collections_surface_id_fkey" TO "record_collections_pane_id_fkey";
