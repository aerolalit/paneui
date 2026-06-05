// End-to-end tests for template & pane icons (#feat-template-icons):
//   - PATCH /v1/templates/:id  set / clear icon_emoji + icon_attachment_id
//   - POST  /v1/templates      icon_emoji at create time
//   - POST  /v1/panes          per-pane icon override (emoji + image)
//   - GET   /templates/:id/icon  cookie-authed image serve + access control
//   - GET   /panes/:id/icon      effective icon (pane override → template)
//   - owner-shell SPA renders img / emoji / monogram in the right precedence
//
// DB engine follows DATABASE_URL (sqlite by default). Uses a filesystem blob
// store so the icon-serve routes can stream real bytes.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import { makeBlobStore } from "../../attachments/index.js";
import type { AttachmentStore } from "../../attachments/store.js";
import { storageKeyFor } from "../../attachments/upload-pipeline.js";
import {
  generateApiKey,
  generatePaneId,
  hashKey,
  keyPrefix,
} from "../../keys.js";
import {
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
} from "../../auth/cookie.js";

let testDb: TestDb;
let prisma: PrismaClient;
let app: Hono;
let blobDir: string;
let store: AttachmentStore;

// A tiny valid PNG (1x1). Bytes match the PNG magic so any sniffing passes.
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex",
);

beforeAll(async () => {
  blobDir = mkdtempSync(join(tmpdir(), "icon-e2e-"));
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);

  const config = loadConfig({
    DATABASE_URL: testDb.dbUrl,
    PUBLIC_URL: "http://localhost:3000",
    BLOB_STORE: "filesystem",
    BLOB_STORE_FS_DIR: blobDir,
    BLOB_MIME_ALLOWLIST:
      "image/png,image/jpeg,image/webp,image/gif,image/svg+xml",
    RATE_LIMIT: "0",
    // Disable the owner-shell open-pane list gate — the icon-tile rendering
    // tests seed owned templates without open panes. The gate has dedicated
    // coverage in template-open-pane-gates.e2e.test.ts.
    TEMPLATE_LIST_MIN_OPEN_PANES: "0",
  });
  store = await makeBlobStore(config);
  app = buildApp(config, prisma, undefined, store);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
  rmSync(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

function bearer(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}
function req(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: bearer(apiKey),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}
function withCookie(cookie: string): RequestInit {
  return { headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` } };
}

// Seed a human + login cookie + a claimed agent (api key). The agent's
// templates/panes are owned by this human.
async function seedHumanAgent(email: string): Promise<{
  humanId: string;
  cookie: string;
  agentId: string;
  apiKey: string;
}> {
  const human = await prisma.human.create({
    data: { email, verifiedAt: new Date() },
  });
  const cookie = generateLoginCookie();
  await prisma.login.create({
    data: {
      humanId: human.id,
      cookieHash: hashLoginCookie(cookie),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const apiKey = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
      name: "agent-" + randomBytes(3).toString("hex"),
      ownerHumanId: human.id,
      claimedAt: new Date(),
    },
  });
  return { humanId: human.id, cookie, agentId: agent.id, apiKey };
}

async function seedTemplate(agentId: string): Promise<string> {
  const t = await prisma.template.create({
    data: {
      ownerId: agentId,
      name: "Tmpl " + randomBytes(3).toString("hex"),
      slug: "tmpl-" + randomBytes(4).toString("hex"),
      latestVersion: 1,
    },
  });
  await prisma.templateVersion.create({
    data: {
      templateId: t.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>hi</p>",
    },
  });
  return t.id;
}

// Directly seed a ready raster Attachment row + write its bytes to the store.
async function seedReadyImage(opts: {
  ownerId: string;
  scope: "agent" | "pane" | "template";
  templateId?: string;
  paneId?: string;
  mime?: string;
  bytes?: Buffer;
  store: AttachmentStore;
}): Promise<string> {
  const bytes = opts.bytes ?? PNG_BYTES;
  const id = "att_" + randomBytes(10).toString("hex");
  const storageKey = storageKeyFor(id);
  await opts.store.put(storageKey, Readable.from(bytes), {
    mime: opts.mime ?? "image/png",
    maxBytes: 10 * 1024 * 1024,
  });
  await prisma.attachment.create({
    data: {
      id,
      ownerId: opts.ownerId,
      scope: opts.scope,
      templateId: opts.templateId ?? null,
      paneId: opts.paneId ?? null,
      mime: opts.mime ?? "image/png",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      storageKey,
      status: "ready",
      confirmedAt: new Date(),
    },
  });
  return id;
}

describe("POST /v1/templates — icon_emoji at create", () => {
  it("persists a valid emoji", async () => {
    const { apiKey } = await seedHumanAgent("a1@example.com");
    const res = await req("POST", "/v1/templates", apiKey, {
      name: "Emoji Tmpl",
      source: "<p>x</p>",
      type: "html-inline",
      icon_emoji: "🚀",
    });
    expect(res.status).toBe(201);
    const { template_id } = (await res.json()) as { template_id: string };
    const row = await prisma.template.findUnique({
      where: { id: template_id },
    });
    expect(row?.iconEmoji).toBe("🚀");
  });

  it("rejects a non-emoji string", async () => {
    const { apiKey } = await seedHumanAgent("a2@example.com");
    const res = await req("POST", "/v1/templates", apiKey, {
      name: "Bad Emoji",
      source: "<p>x</p>",
      type: "html-inline",
      icon_emoji: "AB",
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /v1/templates/:id — icon", () => {
  it("sets and clears icon_emoji", async () => {
    const { apiKey, agentId } = await seedHumanAgent("p1@example.com");
    const id = await seedTemplate(agentId);

    let res = await req("PATCH", `/v1/templates/${id}`, apiKey, {
      icon_emoji: "📋",
    });
    expect(res.status).toBe(200);
    expect(
      (await prisma.template.findUnique({ where: { id } }))?.iconEmoji,
    ).toBe("📋");

    res = await req("PATCH", `/v1/templates/${id}`, apiKey, {
      icon_emoji: null,
    });
    expect(res.status).toBe(200);
    expect(
      (await prisma.template.findUnique({ where: { id } }))?.iconEmoji,
    ).toBeNull();
  });

  it("sets an image icon from a ready template-scoped raster attachment", async () => {
    const { apiKey, agentId } = await seedHumanAgent("p2@example.com");
    const id = await seedTemplate(agentId);
    const attId = await seedReadyImage({
      ownerId: agentId,
      scope: "template",
      templateId: id,
      store,
    });

    const res = await req("PATCH", `/v1/templates/${id}`, apiKey, {
      icon_attachment_id: attId,
    });
    expect(res.status).toBe(200);
    const row = await prisma.template.findUnique({ where: { id } });
    expect(row?.iconAttachmentId).toBe(attId);

    // Clearing with null disconnects it.
    const res2 = await req("PATCH", `/v1/templates/${id}`, apiKey, {
      icon_attachment_id: null,
    });
    expect(res2.status).toBe(200);
    expect(
      (await prisma.template.findUnique({ where: { id } }))?.iconAttachmentId,
    ).toBeNull();
  });

  it("rejects an SVG attachment", async () => {
    const { apiKey, agentId } = await seedHumanAgent("p3@example.com");
    const id = await seedTemplate(agentId);
    const attId = await seedReadyImage({
      ownerId: agentId,
      scope: "template",
      templateId: id,
      mime: "image/svg+xml",
      bytes: Buffer.from("<svg></svg>"),
      store,
    });
    const res = await req("PATCH", `/v1/templates/${id}`, apiKey, {
      icon_attachment_id: attId,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an attachment scoped to a different template (403)", async () => {
    const { apiKey, agentId } = await seedHumanAgent("p4@example.com");
    const id = await seedTemplate(agentId);
    const other = await seedTemplate(agentId);
    const attId = await seedReadyImage({
      ownerId: agentId,
      scope: "template",
      templateId: other, // belongs to a different template
      store,
    });
    const res = await req("PATCH", `/v1/templates/${id}`, apiKey, {
      icon_attachment_id: attId,
    });
    expect(res.status).toBe(403);
  });

  it("rejects an attachment owned by another agent (403)", async () => {
    const { apiKey, agentId } = await seedHumanAgent("p5@example.com");
    const id = await seedTemplate(agentId);
    const stranger = await seedHumanAgent("p5b@example.com");
    const strangerTmpl = await seedTemplate(stranger.agentId);
    const attId = await seedReadyImage({
      ownerId: stranger.agentId,
      scope: "template",
      templateId: strangerTmpl,
      store,
    });
    const res = await req("PATCH", `/v1/templates/${id}`, apiKey, {
      icon_attachment_id: attId,
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/panes — per-pane icon override", () => {
  it("persists icon_emoji + icon_attachment_id", async () => {
    const { apiKey, agentId } = await seedHumanAgent("pane1@example.com");
    const templateId = await seedTemplate(agentId);
    const attId = await seedReadyImage({
      ownerId: agentId,
      scope: "agent",
      store,
    });

    const res = await req("POST", "/v1/panes", apiKey, {
      template: { id: templateId },
      title: "Pane One",
      icon_emoji: "🎯",
      icon_attachment_id: attId,
    });
    expect(res.status).toBe(201);
    const { pane_id } = (await res.json()) as { pane_id: string };
    const row = await prisma.pane.findUnique({ where: { id: pane_id } });
    expect(row?.iconEmoji).toBe("🎯");
    expect(row?.iconAttachmentId).toBe(attId);
  });

  it("rejects an invalid emoji", async () => {
    const { apiKey, agentId } = await seedHumanAgent("pane2@example.com");
    const templateId = await seedTemplate(agentId);
    const res = await req("POST", "/v1/panes", apiKey, {
      template: { id: templateId },
      title: "Bad",
      icon_emoji: "xy",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /templates/:id/icon", () => {
  it("owner can view an unpublished template's image icon", async () => {
    const { agentId, cookie } = await seedHumanAgent("t1@example.com");
    const id = await seedTemplate(agentId);
    const attId = await seedReadyImage({
      ownerId: agentId,
      scope: "template",
      templateId: id,
      store,
    });
    await prisma.template.update({
      where: { id },
      data: { iconAttachmentId: attId },
    });

    const res = await app.fetch(
      new Request(`http://t/templates/${id}/icon`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("a different human gets 403 on unpublished, 200 on published", async () => {
    const { agentId } = await seedHumanAgent("t2owner@example.com");
    const stranger = await seedHumanAgent("t2other@example.com");
    const id = await seedTemplate(agentId);
    const attId = await seedReadyImage({
      ownerId: agentId,
      scope: "template",
      templateId: id,
      store,
    });
    await prisma.template.update({
      where: { id },
      data: { iconAttachmentId: attId },
    });

    // Unpublished → 404 (opaque "not yours") for the stranger.
    let res = await app.fetch(
      new Request(`http://t/templates/${id}/icon`, withCookie(stranger.cookie)),
    );
    expect(res.status).toBe(404);

    // Publish → any logged-in human can view.
    await prisma.template.update({
      where: { id },
      data: { publishedAt: new Date() },
    });
    res = await app.fetch(
      new Request(`http://t/templates/${id}/icon`, withCookie(stranger.cookie)),
    );
    expect(res.status).toBe(200);
  });

  it("404 when the template has no image icon", async () => {
    const { agentId, cookie } = await seedHumanAgent("t3@example.com");
    const id = await seedTemplate(agentId);
    const res = await app.fetch(
      new Request(`http://t/templates/${id}/icon`, withCookie(cookie)),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /panes/:id/icon", () => {
  async function seedPaneWithIcons(opts: {
    agentId: string;
    humanId: string;
    templateIconAttId?: string | null;
    paneIconAttId?: string | null;
  }): Promise<string> {
    const t = await prisma.template.create({
      data: {
        ownerId: opts.agentId,
        name: "PT " + randomBytes(3).toString("hex"),
        slug: "pt-" + randomBytes(4).toString("hex"),
        latestVersion: 1,
        iconAttachmentId: opts.templateIconAttId ?? null,
      },
    });
    const v = await prisma.templateVersion.create({
      data: {
        templateId: t.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p>x</p>",
      },
    });
    const pane = await prisma.pane.create({
      data: {
        id: generatePaneId(),
        agentId: opts.agentId,
        ownerHumanId: opts.humanId,
        templateVersionId: v.id,
        title: "Pane",
        status: "open",
        expiresAt: new Date(Date.now() + 3600_000),
        iconAttachmentId: opts.paneIconAttId ?? null,
      },
    });
    return pane.id;
  }

  it("participant/owner can view; pane override wins over template", async () => {
    const { agentId, humanId, cookie } =
      await seedHumanAgent("pi1@example.com");
    const tmplIcon = await seedReadyImage({
      ownerId: agentId,
      scope: "agent",
      mime: "image/png",
      store,
    });
    const paneIcon = await seedReadyImage({
      ownerId: agentId,
      scope: "agent",
      mime: "image/gif",
      bytes: Buffer.from("GIF89a" + "x".repeat(10)),
      store,
    });
    const paneId = await seedPaneWithIcons({
      agentId,
      humanId,
      templateIconAttId: tmplIcon,
      paneIconAttId: paneIcon,
    });

    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/icon`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    // The pane override (gif) wins over the template icon (png).
    expect(res.headers.get("content-type")).toBe("image/gif");
  });

  it("falls back to the template icon when the pane has none", async () => {
    const { agentId, humanId, cookie } =
      await seedHumanAgent("pi2@example.com");
    const tmplIcon = await seedReadyImage({
      ownerId: agentId,
      scope: "agent",
      store,
    });
    const paneId = await seedPaneWithIcons({
      agentId,
      humanId,
      templateIconAttId: tmplIcon,
      paneIconAttId: null,
    });
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/icon`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("404 when neither pane nor template has an image icon", async () => {
    const { agentId, humanId, cookie } =
      await seedHumanAgent("pi3@example.com");
    const paneId = await seedPaneWithIcons({ agentId, humanId });
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/icon`, withCookie(cookie)),
    );
    expect(res.status).toBe(404);
  });

  it("a non-participant human gets 404", async () => {
    const { agentId, humanId } = await seedHumanAgent("pi4@example.com");
    const stranger = await seedHumanAgent("pi4b@example.com");
    const tmplIcon = await seedReadyImage({
      ownerId: agentId,
      scope: "agent",
      store,
    });
    const paneId = await seedPaneWithIcons({
      agentId,
      humanId,
      templateIconAttId: tmplIcon,
    });
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/icon`, withCookie(stranger.cookie)),
    );
    expect(res.status).toBe(404);
  });
});

describe("owner-shell SPA — icon rendering precedence", () => {
  it("renders an <img> for an image icon, emoji span otherwise, monogram fallback", async () => {
    const { agentId, humanId, cookie } = await seedHumanAgent("r1@example.com");

    // Template A — image icon.
    const imgAtt = await seedReadyImage({
      ownerId: agentId,
      scope: "template",
      store,
    });
    const tImg = await prisma.template.create({
      data: {
        ownerId: agentId,
        name: "ImgTmpl",
        slug: "img-" + randomBytes(4).toString("hex"),
        latestVersion: 1,
        iconAttachmentId: imgAtt,
      },
    });
    await prisma.templateVersion.create({
      data: {
        templateId: tImg.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p>x</p>",
      },
    });

    // Template B — emoji only.
    const tEmoji = await prisma.template.create({
      data: {
        ownerId: agentId,
        name: "EmojiTmpl",
        slug: "emo-" + randomBytes(4).toString("hex"),
        latestVersion: 1,
        iconEmoji: "🌟",
      },
    });
    await prisma.templateVersion.create({
      data: {
        templateId: tEmoji.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p>x</p>",
      },
    });

    // Template C — no icon → monogram.
    const tPlain = await prisma.template.create({
      data: {
        ownerId: agentId,
        name: "PlainTmpl",
        slug: "plain-" + randomBytes(4).toString("hex"),
        latestVersion: 1,
      },
    });
    await prisma.templateVersion.create({
      data: {
        templateId: tPlain.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<p>x</p>",
      },
    });

    void humanId;
    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`/templates/${tImg.id}/icon`);
    expect(html).toContain('class="tile-img"');
    expect(html).toContain('class="tile-emoji"');
    expect(html).toContain("🌟");
    expect(html).toContain('class="tile-monogram"');
  });
});
