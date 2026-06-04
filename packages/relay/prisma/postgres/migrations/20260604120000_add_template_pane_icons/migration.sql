-- Template & pane icons. See the sqlite migration of the same name for the
-- full design. A template (and, as a per-pane override, a pane) can carry
-- either a single-grapheme emoji or an uploaded raster image attachment. NO
-- external URLs. All four columns are nullable; NULL = no icon at that level.
--
-- icon_attachment_id is an FK to attachments(id) with ON DELETE SET NULL so
-- deleting the underlying attachment clears the icon pointer (matching the
-- Prisma relation's onDelete: SetNull). Indexed for the join used by the
-- icon-serve routes.

ALTER TABLE "templates" ADD COLUMN "icon_emoji" TEXT;
ALTER TABLE "templates" ADD COLUMN "icon_attachment_id" TEXT;

ALTER TABLE "panes" ADD COLUMN "icon_emoji" TEXT;
ALTER TABLE "panes" ADD COLUMN "icon_attachment_id" TEXT;

ALTER TABLE "templates"
  ADD CONSTRAINT "templates_icon_attachment_id_fkey"
  FOREIGN KEY ("icon_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "panes"
  ADD CONSTRAINT "panes_icon_attachment_id_fkey"
  FOREIGN KEY ("icon_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
