// Recents hook — record that a logged-in human opened a pane.
//
// Standalone (no dependency on bridge/routes.ts) so the /s/:token shell
// handler can import it without a circular import: routes.ts already exports
// the shell renderers that serve-pane.ts consumes, so the view-recording
// helper lives here instead.
//
// `recordView` upserts the (human, pane) view row and bumps lastViewedAt.
// Best-effort: a failure must never block serving the pane, so every caller
// fires-and-forgets (errors logged + swallowed). Anonymous opens never call
// this (no humanId).

import type { PrismaClient } from "@prisma/client";

export async function recordView(
  prisma: PrismaClient,
  humanId: string,
  paneId: string,
): Promise<void> {
  const now = new Date();
  await prisma.humanPaneView.upsert({
    where: { humanId_paneId: { humanId, paneId } },
    create: { humanId, paneId, firstViewedAt: now, lastViewedAt: now },
    update: { lastViewedAt: now },
  });
}
