-- Optional display name on Human. NULL until set.
ALTER TABLE "humans" ADD COLUMN "name" TEXT;

-- Optional display name on MagicLink. Captured at /v1/auth/request-link
-- and transferred to Human.name on the first successful verify (only
-- when the Human row is freshly created — never overwrites an existing
-- name).
ALTER TABLE "magic_links" ADD COLUMN "name" TEXT;
