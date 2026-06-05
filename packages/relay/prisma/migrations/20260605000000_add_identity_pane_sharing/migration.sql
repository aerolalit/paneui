-- Identity-based pane sharing (additive — no destructive change, no backfill).
--
-- 1. Pane.isPublic — the only new visibility *state*. Default false, so every
--    existing pane stays private. Token sharing is unchanged and layered
--    independently.
-- 2. pane_grants — the "invitation" mode. An owner invites an email; the grant
--    is pending until the invitee logs in (magic-link verify binds it).
-- 3. human_pane_views — per-human view ledger that drives Recents.

ALTER TABLE "panes" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "pane_grants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pane_id" TEXT NOT NULL,
    "human_id" TEXT,
    "invite_email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'participant',
    "invited_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" DATETIME,

    CONSTRAINT "pane_grants_pane_id_fkey" FOREIGN KEY ("pane_id") REFERENCES "panes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pane_grants_pane_id_human_id_key" ON "pane_grants"("pane_id", "human_id");
CREATE UNIQUE INDEX "pane_grants_pane_id_invite_email_key" ON "pane_grants"("pane_id", "invite_email");
CREATE INDEX "pane_grants_human_id_idx" ON "pane_grants"("human_id");

CREATE TABLE "human_pane_views" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "human_id" TEXT NOT NULL,
    "pane_id" TEXT NOT NULL,
    "first_viewed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_viewed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "human_pane_views_pane_id_fkey" FOREIGN KEY ("pane_id") REFERENCES "panes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "human_pane_views_human_id_pane_id_key" ON "human_pane_views"("human_id", "pane_id");
CREATE INDEX "human_pane_views_human_id_last_viewed_at_idx" ON "human_pane_views"("human_id", "last_viewed_at");
