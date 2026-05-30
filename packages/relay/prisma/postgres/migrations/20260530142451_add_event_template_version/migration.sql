-- #268 — Add Event.template_version_id (FK to template_versions) +
-- Event.template_version_num (denormalised version integer).
--
-- After the columns are added, backfill from each event's surface's
-- currently-pinned template version. Existing surfaces have not been
-- upgraded (the upgrade path is #267 + future); so the surface's current
-- pin IS the right value for every event written before this column
-- existed.

ALTER TABLE "events"
  ADD COLUMN "template_version_id" TEXT,
  ADD COLUMN "template_version_num" INTEGER;

ALTER TABLE "events"
  ADD CONSTRAINT "events_template_version_id_fkey"
  FOREIGN KEY ("template_version_id")
  REFERENCES "template_versions" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill in a single UPDATE that joins through surfaces → template_versions.
UPDATE "events" AS e
   SET "template_version_id" = s."template_version_id",
       "template_version_num" = tv."version"
  FROM "surfaces" s
  JOIN "template_versions" tv ON tv."id" = s."template_version_id"
 WHERE e."surface_id" = s."id";
