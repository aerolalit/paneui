-- Favorites move from template-level to pane-level. People use *instances*,
-- not the template they were derived from — so the Home Favorites strip
-- surfaces panes the human keeps coming back to.
--
-- Drop the unused template-favorite table and create the pane-favorite
-- one in its place. Same composite-key shape, just keyed on pane_id.

DROP INDEX IF EXISTS "human_template_favorites_human_id_added_at_idx";
DROP TABLE IF EXISTS "human_template_favorites";

CREATE TABLE "human_pane_favorites" (
    "human_id" TEXT NOT NULL,
    "pane_id" TEXT NOT NULL,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("human_id", "pane_id"),
    CONSTRAINT "human_pane_favorites_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "humans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "human_pane_favorites_pane_id_fkey" FOREIGN KEY ("pane_id") REFERENCES "panes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "human_pane_favorites_human_id_added_at_idx" ON "human_pane_favorites"("human_id", "added_at");
