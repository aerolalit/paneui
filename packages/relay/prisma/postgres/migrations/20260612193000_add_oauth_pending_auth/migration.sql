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
CREATE INDEX "oauth_pending_authorizations_login_session_hash_idx" ON "oauth_pending_authorizations"("login_session_hash");

-- CreateIndex
CREATE INDEX "oauth_pending_authorizations_expires_at_idx" ON "oauth_pending_authorizations"("expires_at");
