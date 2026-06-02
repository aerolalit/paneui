-- Template-level record collections — postgres variant. See the sqlite
-- migration of the same name for the design rationale.

-- AlterTable
ALTER TABLE "template_versions" ADD COLUMN "template_record_schema" JSONB;

-- CreateTable
CREATE TABLE "template_record_collections" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "template_record_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_records" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "record_key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "seq" INTEGER NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "template_record_collections_template_id_name_key"
  ON "template_record_collections"("template_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "template_records_collection_id_record_key_key"
  ON "template_records"("collection_id", "record_key");

-- CreateIndex
CREATE INDEX "template_records_collection_id_seq_idx"
  ON "template_records"("collection_id", "seq");

-- AddForeignKey
ALTER TABLE "template_record_collections"
  ADD CONSTRAINT "template_record_collections_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "templates"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_records"
  ADD CONSTRAINT "template_records_collection_id_fkey"
  FOREIGN KEY ("collection_id") REFERENCES "template_record_collections"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
