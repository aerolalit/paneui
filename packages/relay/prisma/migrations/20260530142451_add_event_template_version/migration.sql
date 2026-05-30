-- #268 — Add Event.template_version_id (FK to template_versions) +
-- Event.template_version_num (denormalised version integer).
-- After the table redefine (SQLite has no in-place ALTER for FKs), backfill
-- both columns from each event's surface's currently-pinned template
-- version. Existing surfaces haven't been upgraded (the upgrade path is
-- #267), so the surface's current pin IS the right value for every event
-- written before this column existed.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "surface_id" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "causation_id" TEXT,
    "idempotency_key" TEXT,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "template_version_id" TEXT,
    "template_version_num" INTEGER,
    CONSTRAINT "events_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "events_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "template_versions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_events" ("author_id", "author_kind", "causation_id", "data", "id", "idempotency_key", "surface_id", "ts", "type") SELECT "author_id", "author_kind", "causation_id", "data", "id", "idempotency_key", "surface_id", "ts", "type" FROM "events";
DROP TABLE "events";
ALTER TABLE "new_events" RENAME TO "events";
CREATE INDEX "events_surface_id_id_idx" ON "events"("surface_id", "id");
CREATE UNIQUE INDEX "events_surface_id_author_id_idempotency_key_key" ON "events"("surface_id", "author_id", "idempotency_key");

-- Backfill pre-existing events from each surface's currently-pinned version.
UPDATE "events"
   SET "template_version_id" = (
         SELECT s."template_version_id"
         FROM "surfaces" s
         WHERE s."id" = "events"."surface_id"
       ),
       "template_version_num" = (
         SELECT tv."version"
         FROM "template_versions" tv
         INNER JOIN "surfaces" s ON s."template_version_id" = tv."id"
         WHERE s."id" = "events"."surface_id"
       );

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
