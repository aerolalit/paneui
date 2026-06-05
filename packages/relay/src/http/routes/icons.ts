// Icon-serve routes — human-facing image icons for templates and panes.
//
//   GET /templates/:id/icon   the template's uploaded icon image
//   GET /panes/:id/icon       the pane's effective icon image
//                             (pane override → template fallback)
//
// Emoji icons are rendered inline as text in the owner shell and never hit
// these routes — only UPLOADED raster images are served here. The bytes live
// in the relay's existing blob store (the same AttachmentStore the agent-side
// GET /v1/attachments/:id streams from), so the decrypt path mirrors that
// route + the participant download bridge exactly (parseEnvelope + decryptBlob)
// and the three can never drift on encryption-at-rest semantics.
//
// Auth is the human login cookie (requireHuman), NOT an agent API key — these
// URLs sit in <img src> inside the cookie-authed owner shell. Authorization:
//   * /templates/:id/icon — published templates are viewable by any logged-in
//     human (the public catalog tile shows them); unpublished templates only
//     by the owning human (any of their claimed agents) — mirrors the shell's
//     own template-visibility rule.
//   * /panes/:id/icon — only a participant or owner of the pane.
//
// Unlike the agent/participant attachment routes (private, no-store — the URL
// is the credential), icon images are CACHEABLE: the credential is the cookie,
// not the URL, and the bytes are immutable per attachment. We send
// `Cache-Control: private, max-age=3600` + a strong ETag (the attachment
// sha256) and honour `If-None-Match` with a 304.

import { Hono, type Context } from "hono";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import { errors } from "../errors.js";
import { setBlobFramingHeaders } from "../../attachments/index.js";

const icons = new Hono<HumanAuthEnv>();

// Scope requireHuman to ONLY the two icon paths — NOT `*`. This sub-app is
// mounted at `/` in app.ts so it can serve both `/templates/:id/icon` and
// `/panes/:id/icon`; a `use("*")` here would gate EVERY route in the app
// (including `/v1/*`) behind the human cookie. Per-path middleware keeps the
// gate where it belongs.
icons.use("/templates/:id/icon", requireHuman);
icons.use("/panes/:id/icon", requireHuman);

// The set of agent ids the human controls (their claimed agents). A template
// is "owned" by the human when its ownerId is one of these.
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

// Stream a ready attachment row's bytes with cacheable icon headers. Mirrors
// the decrypt path in routes/attachments.ts GET /:id and the participant
// download bridge. Returns the Hono Response (304 when the ETag matches).
async function streamIcon(
  c: Context<HumanAuthEnv>,
  prisma: PrismaClient,
  attachmentId: string,
) {
  const store = c.get("blobStore");
  if (!store) {
    throw errors.invalidRequest(
      "attachment storage is not configured on this relay",
    );
  }

  const row = await prisma.attachment.findUnique({
    where: { id: attachmentId },
  });
  // The pointer resolved from a template/pane the caller is allowed to see, so
  // a missing/not-ready/deleted underlying row collapses to 404 — same oracle
  // as a template/pane with no icon at all.
  if (!row || row.status !== "ready" || row.deletedAt !== null) {
    throw errors.notFound();
  }

  // Strong ETag = the content hash. Immutable per attachment, so a matching
  // If-None-Match means the browser already has these exact bytes.
  const etag = `"${row.sha256}"`;
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    c.header("ETag", etag);
    c.header("Cache-Control", "private, max-age=3600");
    // Framing defences on the 304 too — a cached icon must not become
    // frameable just because the bytes weren't re-sent.
    setBlobFramingHeaders(c);
    return c.body(null, 304);
  }

  const stream = await store.get(row.storageKey);
  if (!stream) {
    // Metadata says ready, storage says missing — mark failed + 404 (same
    // recovery as the agent route).
    await prisma.attachment.update({
      where: { id: row.id },
      data: { status: "failed" },
    });
    throw errors.notFound();
  }

  let outputStream: Readable = stream;
  if (row.encryptionEnvelope) {
    const { decryptBlob, parseEnvelope } =
      await import("../../attachments/encrypt.js");
    const { getMasterKey } = await import("../../crypto.js");
    const envelope = parseEnvelope(row.encryptionEnvelope);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const ciphertext = Buffer.concat(chunks);
    const plaintext = decryptBlob(ciphertext, envelope, getMasterKey());
    outputStream = Readable.from(plaintext);
  }

  c.header("Content-Type", row.mime);
  c.header("Content-Length", String(row.size));
  c.header("X-Content-Type-Options", "nosniff");
  // Cookie-authed + immutable bytes → cacheable. `private` keeps it out of
  // shared caches (the icon may belong to an unpublished template).
  c.header("Cache-Control", "private, max-age=3600");
  c.header("ETag", etag);
  // Uploaded icons are validated raster-only at write time (isRasterImageMime
  // in templates/panes routes), so inline is safe here. SVG never reaches an
  // icon row.
  c.header("Content-Disposition", "inline");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Referrer-Policy", "no-referrer");
  // Framing defences shared with the attachment download paths: CSP
  // `default-src 'none'; sandbox; frame-ancestors 'none'` + X-Frame-Options:
  // DENY. Icons sit in <img src> in the cookie-authed owner shell; deny
  // framing + active content regardless.
  setBlobFramingHeaders(c);

  return c.body(Readable.toWeb(outputStream) as unknown as ReadableStream);
}

// GET /templates/:id/icon — the template's uploaded icon image.
icons.get("/templates/:id/icon", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const template = await prisma.template.findUnique({
    where: { id },
    select: {
      ownerId: true,
      publishedAt: true,
      deletedAt: true,
      iconAttachmentId: true,
    },
  });
  if (!template || template.deletedAt !== null) throw errors.notFound();
  if (!template.iconAttachmentId) throw errors.notFound();

  // Access: published → any logged-in human; unpublished → owner only.
  if (template.publishedAt === null) {
    const owned = await claimedAgentIds(prisma, human.id);
    if (!owned.has(template.ownerId)) throw errors.notFound();
  }

  return streamIcon(c, prisma, template.iconAttachmentId);
});

// GET /panes/:id/icon — the pane's effective icon image (pane override falls
// back to the template's icon). 404 when neither has an image icon.
icons.get("/panes/:id/icon", async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");

  const pane = await prisma.pane.findUnique({
    where: { id },
    select: {
      ownerHumanId: true,
      deletedAt: true,
      iconAttachmentId: true,
      participants: {
        where: { humanId: human.id, revokedAt: null },
        select: { id: true },
        take: 1,
      },
      templateVersion: {
        select: { template: { select: { iconAttachmentId: true } } },
      },
    },
  });
  if (!pane || pane.deletedAt !== null) throw errors.notFound();

  // Access: owner OR an active participant bound to this human. Same opaque
  // 404 for "not yours" as for "doesn't exist".
  const isOwner = pane.ownerHumanId === human.id;
  const isParticipant = pane.participants.length > 0;
  if (!isOwner && !isParticipant) throw errors.notFound();

  // Effective icon = pane override else template's icon.
  const effective =
    pane.iconAttachmentId ??
    pane.templateVersion?.template?.iconAttachmentId ??
    null;
  if (!effective) throw errors.notFound();

  return streamIcon(c, prisma, effective);
});

export default icons;
