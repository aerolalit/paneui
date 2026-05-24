
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SurfaceStatus" AS ENUM ('open', 'closed');

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "rate_limit" INTEGER,
    "taste" TEXT,
    "taste_updated_at" TIMESTAMP(3),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "surface_id" TEXT,
    "github_issue_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT,
    "slug" TEXT,
    "description" TEXT,
    "tags" JSONB,
    "latest_version" INTEGER NOT NULL DEFAULT 1,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "template_type" TEXT NOT NULL,
    "template_source" TEXT NOT NULL,
    "event_schema" JSONB,
    "input_schema" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surfaces" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "template_version_id" TEXT NOT NULL,
    "input_data" JSONB,
    "title" TEXT NOT NULL,
    "status" "SurfaceStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "callback_url" TEXT,
    "callback_secret_enc" TEXT,
    "callback_filter" JSONB,

    CONSTRAINT "surfaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participants" (
    "id" TEXT NOT NULL,
    "surface_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" SERIAL NOT NULL,
    "surface_id" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "causation_id" TEXT,
    "idempotency_key" TEXT,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment_tokens" (
    "id" TEXT NOT NULL,
    "attachment_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "once" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMP(3),
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "first_seen_ip_net" TEXT,
    "last_seen_ip_net" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_key_hash_key" ON "agents"("key_hash");

-- CreateIndex
CREATE INDEX "feedback_agent_id_created_at_idx" ON "feedback"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "feedback_created_at_idx" ON "feedback"("created_at");

-- CreateIndex
CREATE INDEX "templates_owner_id_idx" ON "templates"("owner_id");

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

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surfaces" ADD CONSTRAINT "surfaces_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surfaces" ADD CONSTRAINT "surfaces_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participants" ADD CONSTRAINT "participants_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_surface_id_fkey" FOREIGN KEY ("surface_id") REFERENCES "surfaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_tokens" ADD CONSTRAINT "attachment_tokens_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

