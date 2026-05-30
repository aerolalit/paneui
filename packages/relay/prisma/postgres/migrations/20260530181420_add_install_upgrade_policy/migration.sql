-- #267 PR C — auto-advance policy + blocked-notification columns on
-- HumanTemplateInstall. Existing rows default to "pin" (no behavioural
-- change for the install they already have).

ALTER TABLE "human_template_installs"
  ADD COLUMN "upgrade_policy" TEXT NOT NULL DEFAULT 'pin',
  ADD COLUMN "upgrade_blocked_at" TIMESTAMP(3),
  ADD COLUMN "upgrade_blocked_reason" JSONB;
