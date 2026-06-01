-- AlterTable
ALTER TABLE "agents" ADD COLUMN "deleted_at" DATETIME;

-- AlterTable
ALTER TABLE "surfaces" ADD COLUMN "deleted_at" DATETIME;

-- AlterTable
ALTER TABLE "templates" ADD COLUMN "deleted_at" DATETIME;

-- CreateTable
CREATE TABLE "deletion_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "owner_human_id" TEXT,
    "owner_agent_id" TEXT,
    "phase" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_humans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "verified_at" DATETIME,
    "phone" TEXT,
    "home_template_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "soft_retention_days" INTEGER,
    "hard_retention_days" INTEGER,
    CONSTRAINT "humans_home_template_id_fkey" FOREIGN KEY ("home_template_id") REFERENCES "templates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_humans" ("created_at", "email", "home_template_id", "id", "phone", "verified_at") SELECT "created_at", "email", "home_template_id", "id", "phone", "verified_at" FROM "humans";
DROP TABLE "humans";
ALTER TABLE "new_humans" RENAME TO "humans";
CREATE UNIQUE INDEX "humans_email_key" ON "humans"("email");
CREATE INDEX "humans_email_idx" ON "humans"("email");
CREATE INDEX "humans_deleted_at_idx" ON "humans"("deleted_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "deletion_log_owner_human_id_at_idx" ON "deletion_log"("owner_human_id", "at");

-- CreateIndex
CREATE INDEX "deletion_log_entity_type_entity_id_idx" ON "deletion_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "agents_deleted_at_idx" ON "agents"("deleted_at");

-- CreateIndex
CREATE INDEX "surfaces_deleted_at_idx" ON "surfaces"("deleted_at");

-- CreateIndex
CREATE INDEX "templates_deleted_at_idx" ON "templates"("deleted_at");
