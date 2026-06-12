-- CreateTable
CREATE TABLE "oauth_clients" (
    "client_id" TEXT NOT NULL,
    "client_secret_hash" TEXT,
    "client_name" TEXT,
    "redirect_uris" JSONB NOT NULL,
    "grant_types" JSONB NOT NULL,
    "token_endpoint_auth_method" TEXT NOT NULL DEFAULT 'none',
    "scope" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "oauth_auth_codes" (
    "code_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "code_challenge_method" TEXT NOT NULL DEFAULT 'S256',
    "human_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "scope" TEXT,
    "resource" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_auth_codes_pkey" PRIMARY KEY ("code_hash")
);

-- CreateTable
CREATE TABLE "oauth_tokens" (
    "token_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "human_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "scope" TEXT,
    "resource" TEXT,
    "agent_key_enc" TEXT NOT NULL,
    "refresh_for" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "oauth_pending_authorizations" (
    "id" TEXT NOT NULL,
    "login_session_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "state" TEXT,
    "scope" TEXT,
    "resource" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_pending_authorizations_pkey" PRIMARY KEY ("id")
);

-- AlterTable: stable at-rest key for the per-human remote-MCP agent.
ALTER TABLE "agents" ADD COLUMN "mcp_key_enc" TEXT;

-- CreateIndex
CREATE INDEX "oauth_auth_codes_client_id_idx" ON "oauth_auth_codes"("client_id");

-- CreateIndex
CREATE INDEX "oauth_auth_codes_expires_at_idx" ON "oauth_auth_codes"("expires_at");

-- CreateIndex
CREATE INDEX "oauth_tokens_client_id_idx" ON "oauth_tokens"("client_id");

-- CreateIndex
CREATE INDEX "oauth_tokens_human_id_idx" ON "oauth_tokens"("human_id");

-- CreateIndex
CREATE INDEX "oauth_tokens_expires_at_idx" ON "oauth_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "oauth_tokens_kind_idx" ON "oauth_tokens"("kind");

-- CreateIndex
CREATE INDEX "oauth_pending_authorizations_login_session_hash_idx" ON "oauth_pending_authorizations"("login_session_hash");

-- CreateIndex
CREATE INDEX "oauth_pending_authorizations_expires_at_idx" ON "oauth_pending_authorizations"("expires_at");

-- AddForeignKey
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

