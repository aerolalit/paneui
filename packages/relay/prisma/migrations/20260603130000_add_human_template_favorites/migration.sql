-- HumanTemplateFavorite: composite-key star/pin table. Independent of
-- HumanTemplateInstall so a publisher can favorite their own authored
-- template without installing it.
CREATE TABLE "human_template_favorites" (
    "human_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("human_id", "template_id"),
    CONSTRAINT "human_template_favorites_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "humans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "human_template_favorites_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "human_template_favorites_human_id_added_at_idx" ON "human_template_favorites"("human_id", "added_at");
