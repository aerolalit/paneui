-- Three-mode pane access (postgres). See the sqlite migration of the same
-- name for the full design + data-mapping rationale.
--
-- Replace `is_public` boolean with `access_mode` TEXT (plain string, validated
-- in app code). Mapping for existing rows:
--   is_public = true  -> 'public'
--   is_public = false -> 'link'
--
-- Postgres has ALTER COLUMN, so this is a 3-step in-place transform that
-- preserves data: add the new column (defaulted), backfill it from the old
-- boolean, then drop the old column. The token-share path (/s/<token>) is
-- unchanged and untouched by this migration.

-- 1. Add the new column with the 'link' default (so any concurrently-inserted
--    row during the migration window also gets the safe default).
ALTER TABLE "panes" ADD COLUMN "access_mode" TEXT NOT NULL DEFAULT 'link';

-- 2. Backfill: previously-public panes become 'public'; everything else stays
--    'link' (the default already applied above).
UPDATE "panes" SET "access_mode" = 'public' WHERE "is_public" = true;

-- 3. Drop the old boolean.
ALTER TABLE "panes" DROP COLUMN "is_public";
