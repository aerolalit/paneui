-- Add a nullable JSON tags array to panes (filter tags). Snapshotted at
-- create time from the template + per-pane extras; owner-editable later.
ALTER TABLE "panes" ADD COLUMN "tags" JSONB;
