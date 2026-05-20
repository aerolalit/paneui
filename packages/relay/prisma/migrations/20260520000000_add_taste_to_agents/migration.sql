-- Add per-agent freeform "taste notes" — a markdown blob the agent reads
-- before generating a pane artifact and rewrites when the human gives
-- presentation feedback. Per-agent (not per-human) keying is intentional
-- for v1; may move to per-human later.
ALTER TABLE "agents" ADD COLUMN "taste" TEXT;
ALTER TABLE "agents" ADD COLUMN "taste_updated_at" DATETIME;
