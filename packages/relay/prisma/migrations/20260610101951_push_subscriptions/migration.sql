-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "human_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_subscriptions_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "humans" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "tags" JSONB,
    "latest_version" INTEGER NOT NULL DEFAULT 1,
    "last_used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "shape" TEXT NOT NULL DEFAULT 'interactive',
    "published_at" DATETIME,
    "scopes" JSONB,
    "install_count" INTEGER NOT NULL DEFAULT 0,
    "icon_emoji" TEXT,
    "icon_attachment_id" TEXT,
    "deleted_at" DATETIME,
    CONSTRAINT "templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "templates_icon_attachment_id_fkey" FOREIGN KEY ("icon_attachment_id") REFERENCES "attachments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_templates" ("created_at", "deleted_at", "description", "icon_attachment_id", "icon_emoji", "id", "install_count", "last_used_at", "latest_version", "name", "owner_id", "published_at", "scopes", "shape", "slug", "tags", "updated_at") SELECT "created_at", "deleted_at", "description", "icon_attachment_id", "icon_emoji", "id", "install_count", "last_used_at", "latest_version", "name", "owner_id", "published_at", "scopes", "shape", "slug", "tags", "updated_at" FROM "templates";
DROP TABLE "templates";
ALTER TABLE "new_templates" RENAME TO "templates";
CREATE INDEX "templates_owner_id_idx" ON "templates"("owner_id");
CREATE INDEX "templates_published_at_idx" ON "templates"("published_at");
CREATE INDEX "templates_deleted_at_idx" ON "templates"("deleted_at");
CREATE UNIQUE INDEX "templates_owner_id_slug_key" ON "templates"("owner_id", "slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_human_id_idx" ON "push_subscriptions"("human_id");
