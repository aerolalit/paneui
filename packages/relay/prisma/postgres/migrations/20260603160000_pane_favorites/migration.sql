-- Favorites move from template-level to pane-level. See sqlite variant.

DROP INDEX IF EXISTS "human_template_favorites_human_id_added_at_idx";
DROP TABLE IF EXISTS "human_template_favorites";

CREATE TABLE "human_pane_favorites" (
    "human_id" TEXT NOT NULL,
    "pane_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "human_pane_favorites_pkey" PRIMARY KEY ("human_id", "pane_id")
);

CREATE INDEX "human_pane_favorites_human_id_added_at_idx" ON "human_pane_favorites"("human_id", "added_at");

ALTER TABLE "human_pane_favorites"
  ADD CONSTRAINT "human_pane_favorites_human_id_fkey"
  FOREIGN KEY ("human_id") REFERENCES "humans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "human_pane_favorites"
  ADD CONSTRAINT "human_pane_favorites_pane_id_fkey"
  FOREIGN KEY ("pane_id") REFERENCES "panes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
