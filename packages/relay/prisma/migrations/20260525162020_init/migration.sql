-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" DATETIME,
    "revoked_at" DATETIME,
    "rate_limit" INTEGER,
    "taste" TEXT,
    "taste_updated_at" DATETIME,
    "owner_human_id" TEXT,
    "claimed_at" DATETIME,
    CONSTRAINT "agents_owner_human_id_fkey" FOREIGN KEY ("owner_human_id") REFERENCES "humans" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "humans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "verified_at" DATETIME,
    "phone" TEXT,
    "home_template_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "humans_home_template_id_fkey" FOREIGN KEY ("home_template_id") REFERENCES "templates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "logins" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "human_id" TEXT NOT NULL,
    "cookie_hash" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" DATETIME,
    CONSTRAINT "logins_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "humans" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "claim_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "human_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "consumed_at" DATETIME,
    "consumed_by_agent_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "claim_codes_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "humans" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "human_template_installs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "human_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "installed_version" INTEGER NOT NULL,
    "installed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" DATETIME,
    CONSTRAINT "human_template_installs_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "humans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "human_template_installs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "surface_id" TEXT,
    "github_issue_url" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feedback_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "feedback_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "name" TEXT,
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
    CONSTRAINT "templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "template_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "template_type" TEXT NOT NULL,
    "template_source" TEXT NOT NULL,
    "event_schema" JSONB,
    "input_schema" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "surfaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "owner_human_id" TEXT,
    "context_key" TEXT,
    "creator_kind" TEXT,
    "creator_id" TEXT,
    "invite_policy" JSONB,
    "template_version_id" TEXT NOT NULL,
    "input_data" JSONB,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "metadata" JSONB,
    "callback_url" TEXT,
    "callback_secret_enc" TEXT,
    "callback_filter" JSONB,
    CONSTRAINT "surfaces_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "surfaces_owner_human_id_fkey" FOREIGN KEY ("owner_human_id") REFERENCES "humans" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "surfaces_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "template_versions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "participants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "surface_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "human_id" TEXT,
    "agent_id" TEXT,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "joined_at" DATETIME,
    "revoked_at" DATETIME,
    CONSTRAINT "participants_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "participants_human_id_fkey" FOREIGN KEY ("human_id") REFERENCES "humans" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "participants_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "surface_id" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "causation_id" TEXT,
    "idempotency_key" TEXT,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "events_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "surface_id" TEXT,
    "template_id" TEXT,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "storage_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "filename" TEXT,
    "strip_metadata" BOOLEAN NOT NULL DEFAULT true,
    "encryption_envelope" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" DATETIME,
    "deleted_at" DATETIME,
    CONSTRAINT "attachments_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "attachments_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attachments_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "attachment_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attachment_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "once" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" DATETIME,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" DATETIME,
    "first_seen_ip_net" TEXT,
    "last_seen_ip_net" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attachment_tokens_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "attachments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_key_hash_key" ON "agents"("key_hash");

-- CreateIndex
CREATE INDEX "agents_owner_human_id_idx" ON "agents"("owner_human_id");

-- CreateIndex
CREATE UNIQUE INDEX "humans_email_key" ON "humans"("email");

-- CreateIndex
CREATE INDEX "humans_email_idx" ON "humans"("email");

-- CreateIndex
CREATE UNIQUE INDEX "logins_cookie_hash_key" ON "logins"("cookie_hash");

-- CreateIndex
CREATE INDEX "logins_human_id_idx" ON "logins"("human_id");

-- CreateIndex
CREATE INDEX "logins_expires_at_idx" ON "logins"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "claim_codes_code_hash_key" ON "claim_codes"("code_hash");

-- CreateIndex
CREATE INDEX "claim_codes_human_id_idx" ON "claim_codes"("human_id");

-- CreateIndex
CREATE INDEX "claim_codes_expires_at_idx" ON "claim_codes"("expires_at");

-- CreateIndex
CREATE INDEX "human_template_installs_human_id_idx" ON "human_template_installs"("human_id");

-- CreateIndex
CREATE INDEX "human_template_installs_template_id_idx" ON "human_template_installs"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "human_template_installs_human_id_template_id_key" ON "human_template_installs"("human_id", "template_id");

-- CreateIndex
CREATE INDEX "feedback_agent_id_created_at_idx" ON "feedback"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "feedback_created_at_idx" ON "feedback"("created_at");

-- CreateIndex
CREATE INDEX "templates_owner_id_idx" ON "templates"("owner_id");

-- CreateIndex
CREATE INDEX "templates_published_at_idx" ON "templates"("published_at");

-- CreateIndex
CREATE UNIQUE INDEX "templates_owner_id_slug_key" ON "templates"("owner_id", "slug");

-- CreateIndex
CREATE INDEX "template_versions_template_id_idx" ON "template_versions"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_template_id_version_key" ON "template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "surfaces_agent_id_idx" ON "surfaces"("agent_id");

-- CreateIndex
CREATE INDEX "surfaces_expires_at_idx" ON "surfaces"("expires_at");

-- CreateIndex
CREATE INDEX "surfaces_template_version_id_idx" ON "surfaces"("template_version_id");

-- CreateIndex
CREATE INDEX "surfaces_owner_human_id_idx" ON "surfaces"("owner_human_id");

-- CreateIndex
CREATE UNIQUE INDEX "surfaces_template_version_id_owner_human_id_context_key_key" ON "surfaces"("template_version_id", "owner_human_id", "context_key");

-- CreateIndex
CREATE UNIQUE INDEX "participants_token_hash_key" ON "participants"("token_hash");

-- CreateIndex
CREATE INDEX "participants_surface_id_idx" ON "participants"("surface_id");

-- CreateIndex
CREATE INDEX "participants_token_hash_idx" ON "participants"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "participants_surface_id_identity_id_key" ON "participants"("surface_id", "identity_id");

-- CreateIndex
CREATE INDEX "events_surface_id_id_idx" ON "events"("surface_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "events_surface_id_author_id_idempotency_key_key" ON "events"("surface_id", "author_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");

-- CreateIndex
CREATE INDEX "attachments_owner_id_idx" ON "attachments"("owner_id");

-- CreateIndex
CREATE INDEX "attachments_scope_owner_id_idx" ON "attachments"("scope", "owner_id");

-- CreateIndex
CREATE INDEX "attachments_surface_id_idx" ON "attachments"("surface_id");

-- CreateIndex
CREATE INDEX "attachments_template_id_idx" ON "attachments"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_tokens_token_hash_key" ON "attachment_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "attachment_tokens_attachment_id_idx" ON "attachment_tokens"("attachment_id");

-- CreateIndex
CREATE INDEX "attachment_tokens_expires_at_idx" ON "attachment_tokens"("expires_at");
