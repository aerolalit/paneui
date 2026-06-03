-- Template-level record collections (#XYZ).
--
-- Shared, publisher-curated content scoped to a Template head, visible to
-- every pane derived from any version of the template. Mirrors the per-pane
-- records subsystem (record_collections / pane_records) but anchored to the
-- template's head, not a pane.
--
-- Schema lives on TemplateVersion (so it can evolve through version bumps,
-- gated by the schema-compat check); data lives on the Template head (so it
-- persists across versions).

-- AlterTable — declare per-template record schema on each version.
ALTER TABLE "template_versions" ADD COLUMN "template_record_schema" JSONB;

-- CreateTable — one row per declared collection under a template.
-- Created implicitly on first write into the collection.
CREATE TABLE "template_record_collections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "template_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "template_record_collections_template_id_fkey"
      FOREIGN KEY ("template_id") REFERENCES "templates" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable — one row per record. Mirrors pane_records column-for-column
-- except the FK points at template_record_collections.
CREATE TABLE "template_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "collection_id" TEXT NOT NULL,
    "record_key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "seq" INTEGER NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "deleted_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "template_records_collection_id_fkey"
      FOREIGN KEY ("collection_id") REFERENCES "template_record_collections" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex — natural-key dedup on (template, collection name).
CREATE UNIQUE INDEX "template_record_collections_template_id_name_key"
  ON "template_record_collections"("template_id", "name");

-- CreateIndex — natural-key dedup on (collection, record_key).
CREATE UNIQUE INDEX "template_records_collection_id_record_key_key"
  ON "template_records"("collection_id", "record_key");

-- CreateIndex — cursor index for ?since=<seq> delta reads.
CREATE INDEX "template_records_collection_id_seq_idx"
  ON "template_records"("collection_id", "seq");
