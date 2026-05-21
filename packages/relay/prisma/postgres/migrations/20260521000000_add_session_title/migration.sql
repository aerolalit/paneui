-- Per-session tab title shown in the browser's <title>. Set by the agent at
-- session create (or resolved from Artifact.name for named-artifact sessions).
-- The DEFAULT backfills any pre-existing rows for the NOT NULL column; the
-- DROP DEFAULT that follows makes the column NOT NULL with no DB-level
-- default, since the relay always supplies a value at insert time.
ALTER TABLE "sessions" ADD COLUMN "title" TEXT NOT NULL DEFAULT 'Pane Session';
ALTER TABLE "sessions" ALTER COLUMN "title" DROP DEFAULT;
