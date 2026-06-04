-- Require Template.name (drop the nullable column). Inline `pane create` used
-- to create anonymous templates with name = NULL, which the owner-shell UI
-- rendered as a raw cuid id. Both create paths now supply a name (enforced at
-- the validation layer in the same change); this makes the invariant a DB
-- guarantee so it can never regress.
--
-- Backfill any pre-existing NULL names FIRST: the rebuilt table below is
-- populated by `INSERT ... SELECT "name"`, which would fail against the new
-- NOT NULL column on a NULL row. 'Untitled template' matches the owner-shell's
-- display fallback. slug stays nullable (optional by design).
UPDATE "templates" SET "name" = 'Untitled template' WHERE "name" IS NULL;

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
    "deleted_at" DATETIME,
    CONSTRAINT "templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_templates" ("created_at", "deleted_at", "description", "id", "install_count", "last_used_at", "latest_version", "name", "owner_id", "published_at", "scopes", "shape", "slug", "tags", "updated_at") SELECT "created_at", "deleted_at", "description", "id", "install_count", "last_used_at", "latest_version", "name", "owner_id", "published_at", "scopes", "shape", "slug", "tags", "updated_at" FROM "templates";
DROP TABLE "templates";
ALTER TABLE "new_templates" RENAME TO "templates";
CREATE INDEX "templates_owner_id_idx" ON "templates"("owner_id");
CREATE INDEX "templates_published_at_idx" ON "templates"("published_at");
CREATE INDEX "templates_deleted_at_idx" ON "templates"("deleted_at");
CREATE UNIQUE INDEX "templates_owner_id_slug_key" ON "templates"("owner_id", "slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
