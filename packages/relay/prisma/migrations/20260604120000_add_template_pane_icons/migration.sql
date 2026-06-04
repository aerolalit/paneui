-- Template & pane icons. A template (and, as a per-pane override, a pane) can
-- carry either a single-grapheme emoji or an uploaded raster image attachment.
-- NO external image URLs. Panes inherit their template's icon unless they set
-- their own. All four columns are nullable; NULL = no icon at that level
-- (render falls back to emoji, then the gradient monogram).
--
-- icon_attachment_id is an FK to attachments(id) with ON DELETE SET NULL in the
-- Prisma model. Following the repo's sqlite migration convention (added-column
-- FKs are not enforced inline — see add_human_* migrations), we add bare
-- columns here; referential integrity is enforced at the application layer.

ALTER TABLE "templates" ADD COLUMN "icon_emoji" TEXT;
ALTER TABLE "templates" ADD COLUMN "icon_attachment_id" TEXT;

ALTER TABLE "panes" ADD COLUMN "icon_emoji" TEXT;
ALTER TABLE "panes" ADD COLUMN "icon_attachment_id" TEXT;
