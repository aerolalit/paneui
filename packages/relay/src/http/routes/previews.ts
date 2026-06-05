// Artifact-preview routes — owner-facing, non-interactive thumbnails rendered
// into the lazy iframes on the owner-shell home cards.
//
//   GET /panes/:id/preview      a live preview of the pane's artifact, rendered
//                               with the pane's real input_data
//   GET /templates/:id/preview  a preview of the template's LATEST version,
//                               rendered with input_data = null (placeholder)
//
// These return the SAME wrapped HTML the live viewer's `/content` serves, under
// the SAME CSP (see PREVIEW_CSP) — but standalone: no shell, no WebSocket, no
// postMessage init. The artifact's `inputData` is embedded directly and a
// minimal inert `window.pane` shim is shipped before it (preview-render.ts).
//
// Auth is the human login cookie (requireHuman), NOT an agent API key — the
// URLs sit in `<iframe src>` inside the cookie-authed owner shell. The
// authorization + 404-not-403 error oracle mirror the icon routes exactly so
// the two never drift:
//   * /panes/:id/preview      — owner of the pane (ownerHumanId === human.id)
//                               OR the pane's agent is one of the human's
//                               claimed agents. 404 otherwise.
//   * /templates/:id/preview  — owner (template.ownerId is a claimed agent) OR
//                               installed by the human OR published. Matches the
//                               template visibility reachable from /home.
//
// Unlike the icon routes (cacheable; immutable bytes) the preview body embeds
// per-instance input_data and is served `private, no-store`, same as
// `/content`.

import { Hono, type Context } from "hono";
import type { PrismaClient } from "@prisma/client";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import { errors } from "../errors.js";
import {
  wrapArtifactForPreview,
  PREVIEW_CSP,
} from "../../bridge/preview-render.js";
import { PERMISSIONS_POLICY } from "../../bridge/routes.js";

const previews = new Hono<HumanAuthEnv>();

// Scope requireHuman to ONLY the two preview paths — NOT `*`. This sub-app is
// mounted at `/` in app.ts (mirroring icons.ts) so it can serve both
// `/templates/:id/preview` and `/panes/:id/preview`; a `use("*")` here would
// gate EVERY route in the app behind the human cookie.
previews.use("/templates/:id/preview", requireHuman);
previews.use("/panes/:id/preview", requireHuman);

// The set of agent ids the human controls (their claimed agents). A pane or
// template is "owned" by the human when its agent owner is one of these.
// Mirrors claimedAgentIds() in icons.ts and loadShellData().
async function claimedAgentIds(
  prisma: PrismaClient,
  humanId: string,
): Promise<Set<string>> {
  const rows = await prisma.agent.findMany({
    where: { ownerHumanId: humanId, deletedAt: null },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

// Resolve a template-version's body to a preview-renderable artifact. html-ref
// is not implemented in v1 (rejected at POST), so any non-`html-inline` type
// renders a tiny placeholder rather than erroring — same shape the viewer's
// /content uses for the html-ref defence-in-depth branch.
function artifactBodyFor(version: {
  templateType: string;
  templateSource: string;
}): string {
  return version.templateType === "html-inline"
    ? version.templateSource
    : "<!-- template.type=html-ref is not implemented in v1 -->";
}

// Common response shaping: the wrapped doc + the viewer CSP + no-store. The
// iframe sandbox lives on the `<iframe>` element in the shell; the document
// itself carries the CSP + Permissions-Policy belt-and-braces.
function sendPreview(
  c: Context<HumanAuthEnv>,
  artifactBody: string,
  inputData: unknown,
) {
  c.header("Content-Security-Policy", PREVIEW_CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Permissions-Policy", PERMISSIONS_POLICY);
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Cache-Control", "private, no-store");
  return c.body(wrapArtifactForPreview(artifactBody, inputData));
}

// GET /panes/:id/preview — the pane's artifact rendered with its real
// input_data. Owner or claimed-agent scope only; 404 otherwise.
previews.get("/panes/:id/preview", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const pane = await prisma.pane.findUnique({
    where: { id },
    select: {
      ownerHumanId: true,
      agentId: true,
      deletedAt: true,
      inputData: true,
      templateVersion: {
        select: { templateType: true, templateSource: true },
      },
    },
  });
  if (!pane || pane.deletedAt !== null) throw errors.notFound();

  // Access: owner OR the pane's agent is one of the human's claimed agents.
  // Same opaque 404 for "not yours" as for "doesn't exist".
  const isOwner = pane.ownerHumanId === human.id;
  if (!isOwner) {
    const owned = await claimedAgentIds(prisma, human.id);
    if (!owned.has(pane.agentId)) throw errors.notFound();
  }

  return sendPreview(c, artifactBodyFor(pane.templateVersion), pane.inputData);
});

// GET /templates/:id/preview — the template's LATEST version rendered with
// input_data = null (placeholder state, no instance). Owner / installed /
// published only; 404 otherwise.
previews.get("/templates/:id/preview", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const template = await prisma.template.findUnique({
    where: { id },
    select: {
      ownerId: true,
      publishedAt: true,
      deletedAt: true,
      latestVersion: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: { templateType: true, templateSource: true },
      },
    },
  });
  if (!template || template.deletedAt !== null) throw errors.notFound();

  // Access: published → any logged-in human; else owner OR installer. Mirrors
  // the template visibility reachable from /home (owned + installed + public).
  if (template.publishedAt === null) {
    const owned = await claimedAgentIds(prisma, human.id);
    const isOwner = owned.has(template.ownerId);
    let isInstaller = false;
    if (!isOwner) {
      const install = await prisma.humanTemplateInstall.findFirst({
        where: { humanId: human.id, templateId: id, uninstalledAt: null },
        select: { id: true },
      });
      isInstaller = install !== null;
    }
    if (!isOwner && !isInstaller) throw errors.notFound();
  }

  const version = template.versions[0];
  // A template with no version row is unreachable via /home (every template has
  // at least version 1), but guard anyway — render the placeholder.
  const artifactBody = version
    ? artifactBodyFor(version)
    : "<!-- template has no version -->";

  return sendPreview(c, artifactBody, null);
});

export default previews;
