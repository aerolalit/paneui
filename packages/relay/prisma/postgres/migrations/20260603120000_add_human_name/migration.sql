-- Optional display name on Human + carry slot on MagicLink. See sqlite
-- migration of the same name for the design.
ALTER TABLE "humans" ADD COLUMN "name" TEXT;
ALTER TABLE "magic_links" ADD COLUMN "name" TEXT;
