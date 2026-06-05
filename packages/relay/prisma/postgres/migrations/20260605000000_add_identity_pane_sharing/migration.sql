-- Identity-based pane sharing (additive — no backfill). See the sqlite
-- migration of the same name for the design.

ALTER TABLE "panes" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "pane_grants" (
    "id" TEXT NOT NULL,
    "pane_id" TEXT NOT NULL,
    "human_id" TEXT,
    "invite_email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'participant',
    "invited_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "pane_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pane_grants_pane_id_human_id_key" ON "pane_grants"("pane_id", "human_id");
CREATE UNIQUE INDEX "pane_grants_pane_id_invite_email_key" ON "pane_grants"("pane_id", "invite_email");
CREATE INDEX "pane_grants_human_id_idx" ON "pane_grants"("human_id");

CREATE TABLE "human_pane_views" (
    "id" TEXT NOT NULL,
    "human_id" TEXT NOT NULL,
    "pane_id" TEXT NOT NULL,
    "first_viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "human_pane_views_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "human_pane_views_human_id_pane_id_key" ON "human_pane_views"("human_id", "pane_id");
CREATE INDEX "human_pane_views_human_id_last_viewed_at_idx" ON "human_pane_views"("human_id", "last_viewed_at");

ALTER TABLE "pane_grants"
  ADD CONSTRAINT "pane_grants_pane_id_fkey"
  FOREIGN KEY ("pane_id") REFERENCES "panes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "human_pane_views"
  ADD CONSTRAINT "human_pane_views_pane_id_fkey"
  FOREIGN KEY ("pane_id") REFERENCES "panes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
