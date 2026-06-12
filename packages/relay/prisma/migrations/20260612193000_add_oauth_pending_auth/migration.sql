-- CreateTable
CREATE TABLE "oauth_pending_authorizations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "login_session_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "state" TEXT,
    "scope" TEXT,
    "resource" TEXT,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AlterTable: stable at-rest key for the per-human remote-MCP agent (no
-- rotation on re-authorization, so live OAuth tokens keep working).
ALTER TABLE "agents" ADD COLUMN "mcp_key_enc" TEXT;

-- CreateIndex
CREATE INDEX "oauth_pending_authorizations_login_session_hash_idx" ON "oauth_pending_authorizations"("login_session_hash");

-- CreateIndex
CREATE INDEX "oauth_pending_authorizations_expires_at_idx" ON "oauth_pending_authorizations"("expires_at");
