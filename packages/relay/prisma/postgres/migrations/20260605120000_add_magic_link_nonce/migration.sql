-- F-16 — pre-login nonce binding on MagicLink (login-CSRF / session-fixation
-- defence). See the sqlite migration of the same name for the design.
ALTER TABLE "magic_links" ADD COLUMN "nonce_hash" TEXT;
