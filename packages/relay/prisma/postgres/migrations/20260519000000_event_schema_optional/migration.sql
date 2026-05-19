-- Make artifact_versions.event_schema nullable to support view-only artifacts.
--
-- A view-only artifact (report/dashboard/chart) declares no event schema: the
-- human only views it and emits no page/agent events. An absent event_schema
-- is an empty, strictly-enforced event vocabulary — every page/agent emit is
-- rejected with unknown_event_type. See packages/relay/src/core/validation.ts.
ALTER TABLE "artifact_versions" ALTER COLUMN "event_schema" DROP NOT NULL;
