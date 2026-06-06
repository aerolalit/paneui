-- Three-mode pane access. Replace the `is_public` boolean on `panes` with a
-- single `access_mode` enum-like string (plain TEXT, validated in app code —
-- same approach as `pane_grants.role`). Three values, default 'link':
--   - 'invite_only' — only invited emails (after login) may open /p/:paneId.
--   - 'link' (DEFAULT) — anyone with the /p URL opens it read-only, no login.
--   - 'public' — anyone opens it read-only, no login (discovery is a follow-up).
--
-- Data mapping for existing rows (preserve the old boolean's meaning):
--   is_public = 1 (true)  -> 'public'
--   is_public = 0 (false) -> 'link'
-- 'link' is the new default for false because pre-existing private panes were
-- only ever reachable via a token /s/<link> (which is unchanged), so mapping
-- them to 'link' keeps that capability link working without forcing a login —
-- it does NOT widen identity-share access (no grants are created).
--
-- The token-share path (/s/<token>) is UNCHANGED and independent of
-- access_mode; this migration does not touch participants/grants.
--
-- SQLite has no ALTER COLUMN, so this follows Prisma's RedefineTables pattern:
-- build a new table with the new column, copy rows across (mapping the boolean
-- into the new column in the INSERT ... SELECT), drop the old table, rename.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_panes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "owner_human_id" TEXT,
    "access_mode" TEXT NOT NULL DEFAULT 'link',
    "context_key" TEXT,
    "creator_kind" TEXT,
    "creator_id" TEXT,
    "invite_policy" JSONB,
    "template_version_id" TEXT NOT NULL,
    "input_data" JSONB,
    "title" TEXT NOT NULL,
    "preamble" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "metadata" JSONB,
    "callback_url" TEXT,
    "callback_secret_enc" TEXT,
    "callback_filter" JSONB,
    "icon_emoji" TEXT,
    "icon_attachment_id" TEXT,
    "deleted_at" DATETIME,
    CONSTRAINT "panes_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "panes_owner_human_id_fkey" FOREIGN KEY ("owner_human_id") REFERENCES "humans" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "panes_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "template_versions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "panes_icon_attachment_id_fkey" FOREIGN KEY ("icon_attachment_id") REFERENCES "attachments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_panes" ("agent_id", "callback_filter", "callback_secret_enc", "callback_url", "context_key", "created_at", "creator_id", "creator_kind", "deleted_at", "expires_at", "icon_attachment_id", "icon_emoji", "id", "input_data", "invite_policy", "metadata", "owner_human_id", "preamble", "status", "template_version_id", "title", "access_mode") SELECT "agent_id", "callback_filter", "callback_secret_enc", "callback_url", "context_key", "created_at", "creator_id", "creator_kind", "deleted_at", "expires_at", "icon_attachment_id", "icon_emoji", "id", "input_data", "invite_policy", "metadata", "owner_human_id", "preamble", "status", "template_version_id", "title", CASE WHEN "is_public" = 1 THEN 'public' ELSE 'link' END FROM "panes";
DROP TABLE "panes";
ALTER TABLE "new_panes" RENAME TO "panes";
CREATE INDEX "panes_agent_id_idx" ON "panes"("agent_id");
CREATE INDEX "panes_expires_at_idx" ON "panes"("expires_at");
CREATE INDEX "panes_template_version_id_idx" ON "panes"("template_version_id");
CREATE INDEX "panes_owner_human_id_idx" ON "panes"("owner_human_id");
CREATE INDEX "panes_deleted_at_idx" ON "panes"("deleted_at");
CREATE UNIQUE INDEX "panes_template_version_id_owner_human_id_context_key_key" ON "panes"("template_version_id", "owner_human_id", "context_key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
