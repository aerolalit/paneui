-- Require Template.name (NOT NULL). See the sqlite migration of the same name
-- for the full rationale: inline `pane create` used to create anonymous
-- templates with name = NULL, the owner-shell rendered those as a raw cuid,
-- and both create paths now supply a name. This enforces the invariant at the
-- DB so it can never regress.
--
-- Backfill any pre-existing NULL names BEFORE adding the constraint, or the
-- ALTER would fail on existing rows. 'Untitled template' matches the
-- owner-shell's display fallback. slug stays nullable (optional by design).
UPDATE "templates" SET "name" = 'Untitled template' WHERE "name" IS NULL;

-- AlterTable
ALTER TABLE "templates" ALTER COLUMN "name" SET NOT NULL;
