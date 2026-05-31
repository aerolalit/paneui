-- #288 — Records foundation. Adds TemplateVersion.record_schema and the two
-- record tables (record_collections, surface_records). Schema-only; no
-- business logic ships in this migration.
--
-- Note: `prisma migrate dev` flags an unrelated drift on `events.id`
-- (BIGINT vs SERIAL). That drift is intentional and documented in
-- 20260525162021_event_id_bigint/migration.sql — the shared Prisma model
-- keeps the field as `Int` so the generated client type stays `number` on
-- both sqlite and postgres, and `migrate deploy` (CI/prod) applies SQL
-- verbatim without diffing. The auto-generated AlterTable that would have
-- "fixed" the column back to int4 has been removed by hand.

-- AlterTable
ALTER TABLE "template_versions" ADD COLUMN     "record_schema" JSONB;

-- CreateTable
CREATE TABLE "record_collections" (
    "id" TEXT NOT NULL,
    "surface_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "record_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surface_records" (
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

    CONSTRAINT "surface_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "record_collections_surface_id_name_key" ON "record_collections"("surface_id", "name");

-- CreateIndex
CREATE INDEX "surface_records_collection_id_seq_idx" ON "surface_records"("collection_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "surface_records_collection_id_record_key_key" ON "surface_records"("collection_id", "record_key");

-- AddForeignKey
ALTER TABLE "record_collections" ADD CONSTRAINT "record_collections_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surface_records" ADD CONSTRAINT "surface_records_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "record_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
