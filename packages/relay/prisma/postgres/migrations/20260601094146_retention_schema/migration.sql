-- #302 — Retention schema foundation. Adds `deleted_at` to soft-deletable
-- entities (agents, humans, templates, surfaces), adds tier + retention
-- overrides to humans, and creates the `deletion_log` audit table.
-- Schema-only; no business logic. Sweepers + routes + trash API ship in
-- follow-up issues (#303 #304 #305 #306).

-- AlterTable: agents — soft-delete column
ALTER TABLE "agents" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable: humans — soft-delete + retention policy
ALTER TABLE "humans" ADD COLUMN     "deleted_at"          TIMESTAMP(3);
ALTER TABLE "humans" ADD COLUMN     "tier"                TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "humans" ADD COLUMN     "soft_retention_days" INTEGER;
ALTER TABLE "humans" ADD COLUMN     "hard_retention_days" INTEGER;

-- AlterTable: templates — soft-delete column
ALTER TABLE "templates" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable: surfaces — soft-delete column
ALTER TABLE "surfaces" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- CreateTable: deletion_log (append-only audit trail)
CREATE TABLE "deletion_log" (
    "id"             TEXT NOT NULL,
    "entity_type"    TEXT NOT NULL,
    "entity_id"      TEXT NOT NULL,
    "owner_human_id" TEXT,
    "owner_agent_id" TEXT,
    "phase"          TEXT NOT NULL,
    "reason"         TEXT NOT NULL,
    "at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agents_deleted_at_idx"    ON "agents"   ("deleted_at");
CREATE INDEX "humans_deleted_at_idx"    ON "humans"   ("deleted_at");
CREATE INDEX "templates_deleted_at_idx" ON "templates"("deleted_at");
CREATE INDEX "surfaces_deleted_at_idx"  ON "surfaces" ("deleted_at");

-- CreateIndex: deletion_log query paths
--   "what did this human delete, ordered by most recent" → (owner_human_id, at)
--   "find the audit row for this specific entity" → (entity_type, entity_id)
CREATE INDEX "deletion_log_owner_human_id_at_idx"     ON "deletion_log"("owner_human_id", "at");
CREATE INDEX "deletion_log_entity_type_entity_id_idx" ON "deletion_log"("entity_type", "entity_id");
