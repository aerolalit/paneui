-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_human_template_installs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "human_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "installed_version" INTEGER NOT NULL,
    "installed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" DATETIME,
    "upgrade_policy" TEXT NOT NULL DEFAULT 'pin',
    "upgrade_blocked_at" DATETIME,
    "upgrade_blocked_reason" JSONB,
    CONSTRAINT "human_template_installs_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "humans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "human_template_installs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_human_template_installs" ("human_id", "id", "installed_at", "installed_version", "template_id", "uninstalled_at") SELECT "human_id", "id", "installed_at", "installed_version", "template_id", "uninstalled_at" FROM "human_template_installs";
DROP TABLE "human_template_installs";
ALTER TABLE "new_human_template_installs" RENAME TO "human_template_installs";
CREATE INDEX "human_template_installs_human_id_idx" ON "human_template_installs"("human_id");
CREATE INDEX "human_template_installs_template_id_idx" ON "human_template_installs"("template_id");
CREATE UNIQUE INDEX "human_template_installs_human_id_template_id_key" ON "human_template_installs"("human_id", "template_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
