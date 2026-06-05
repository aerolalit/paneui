-- F-16 — pre-login nonce binding on MagicLink (login-CSRF / session-fixation
-- defence). sha256(nonce); the raw nonce lives only in the requester's
-- short-lived cookie. Nullable so existing rows (and non-cookie clients) keep
-- working under the verify-side fallback.
ALTER TABLE "magic_links" ADD COLUMN "nonce_hash" TEXT;
