-- Per-session tab title shown in the browser's <title>. Set by the agent at
-- session create (or resolved from Artifact.name for named-artifact sessions).
-- The default backfills any pre-existing rows for the NOT NULL column. The
-- relay always supplies a value going forward, so in practice the DB-level
-- default never fires. SQLite cannot DROP DEFAULT cheaply (it would require
-- copying the entire table into a new one), so we deliberately leave the
-- default in place — it is effectively dead code at the storage layer.
ALTER TABLE "sessions" ADD COLUMN "title" TEXT NOT NULL DEFAULT 'Pane Session';
