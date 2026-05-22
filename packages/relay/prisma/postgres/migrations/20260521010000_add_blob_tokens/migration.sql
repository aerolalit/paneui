-- Blob tokens: each row mints one /b/<token> capability URL. The token's
-- TTL is scope-bound at mint time (30d for artifact-scope blobs, the
-- session's TTL for session-scope, 24h for agent-scope). `once=true` self-
-- deletes the token on its first successful GET.
--
-- token_hash is sha256(token) — the token itself is never stored. Mirrors
-- how Agent keys and Participant tokens are persisted.
--
-- Audit columns persist /24-truncated IPv4 (or /48-truncated IPv6) ranges
-- only. Full requester IPs are never written.
CREATE TABLE "blob_tokens" (
  "id" TEXT NOT NULL,
  "blob_id" TEXT NOT NULL,
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
  CONSTRAINT "blob_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blob_tokens_token_hash_key" ON "blob_tokens"("token_hash");
CREATE INDEX "blob_tokens_blob_id_idx" ON "blob_tokens"("blob_id");
CREATE INDEX "blob_tokens_expires_at_idx" ON "blob_tokens"("expires_at");

ALTER TABLE "blob_tokens" ADD CONSTRAINT "blob_tokens_blob_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "blobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
