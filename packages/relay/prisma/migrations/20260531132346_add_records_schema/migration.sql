-- AlterTable
ALTER TABLE "template_versions" ADD COLUMN "record_schema" JSONB;

-- CreateTable
CREATE TABLE "record_collections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "surface_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "record_collections_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "surface_records" (
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
    CONSTRAINT "surface_records_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "record_collections" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "record_collections_surface_id_name_key" ON "record_collections"("surface_id", "name");

-- CreateIndex
CREATE INDEX "surface_records_collection_id_seq_idx" ON "surface_records"("collection_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "surface_records_collection_id_record_key_key" ON "surface_records"("collection_id", "record_key");
