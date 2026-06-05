// End-to-end tests for the artifact-preview endpoints (#feat-card-preview-thumbnails):
//   - GET /panes/:id/preview      owner-authed live artifact thumbnail
//   - GET /templates/:id/preview  latest-version thumbnail (placeholder inputData)
//   - owner-shell SPA renders a <iframe class="tile-preview"> on big monogram
//     cards (favorites / app tiles / recents) but NOT on emoji/image cards or
//     the 44px pane-row.
//
// DB engine follows DATABASE_URL (sqlite by default).

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

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex",
);

beforeAll(async () => {
  blobDir = mkdtempSync(join(tmpdir(), "preview-e2e-"));
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
    // The shell-render test seeds owned templates without open panes.
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

function withCookie(cookie: string): RequestInit {
  return { headers: { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` } };
}

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

// Seed a template + version with a chosen body / type, returning ids.
async function seedTemplate(opts: {
  agentId: string;
  source?: string;
  templateType?: string;
  publishedAt?: Date | null;
  iconEmoji?: string | null;
  iconAttachmentId?: string | null;
}): Promise<{ templateId: string; versionId: string }> {
  const t = await prisma.template.create({
    data: {
      ownerId: opts.agentId,
      name: "Tmpl " + randomBytes(3).toString("hex"),
      slug: "tmpl-" + randomBytes(4).toString("hex"),
      latestVersion: 1,
      publishedAt: opts.publishedAt ?? null,
      iconEmoji: opts.iconEmoji ?? null,
      iconAttachmentId: opts.iconAttachmentId ?? null,
    },
  });
  const v = await prisma.templateVersion.create({
    data: {
      templateId: t.id,
      version: 1,
      templateType: opts.templateType ?? "html-inline",
      templateSource: opts.source ?? "<p>hi</p>",
    },
  });
  return { templateId: t.id, versionId: v.id };
}

async function seedPane(opts: {
  agentId: string;
  humanId: string;
  versionId: string;
  inputData?: unknown;
}): Promise<string> {
  const pane = await prisma.pane.create({
    data: {
      id: generatePaneId(),
      agentId: opts.agentId,
      ownerHumanId: opts.humanId,
      templateVersionId: opts.versionId,
      title: "Pane " + randomBytes(3).toString("hex"),
      status: "open",
      expiresAt: new Date(Date.now() + 3600_000),
      inputData:
        opts.inputData === undefined ? undefined : (opts.inputData as object),
    },
  });
  return pane.id;
}

async function seedReadyImage(opts: {
  ownerId: string;
  scope: "agent" | "pane" | "template";
  templateId?: string;
}): Promise<string> {
  const id = "att_" + randomBytes(10).toString("hex");
  const storageKey = storageKeyFor(id);
  await store.put(storageKey, Readable.from(PNG_BYTES), {
    mime: "image/png",
    maxBytes: 10 * 1024 * 1024,
  });
  await prisma.attachment.create({
    data: {
      id,
      ownerId: opts.ownerId,
      scope: opts.scope,
      templateId: opts.templateId ?? null,
      mime: "image/png",
      size: PNG_BYTES.length,
      sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
      storageKey,
      status: "ready",
      confirmedAt: new Date(),
    },
  });
  return id;
}

const VIEWER_CSP_BITS = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: attachment:",
  "media-src attachment:",
  "font-src data:",
  "connect-src 'none'",
  "frame-ancestors 'self'",
];

describe("GET /panes/:id/preview", () => {
  it("owner → 200 text/html with artifact body, embedded inputData, viewer CSP", async () => {
    const { agentId, humanId, cookie } =
      await seedHumanAgent("pv1@example.com");
    const { versionId } = await seedTemplate({
      agentId,
      source: "<h1>Preview Body Marker</h1>",
    });
    const paneId = await seedPane({
      agentId,
      humanId,
      versionId,
      inputData: { prTitle: "Ship it", count: 3 },
    });

    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/preview`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const bit of VIEWER_CSP_BITS) expect(csp).toContain(bit);
    expect(res.headers.get("cache-control")).toContain("no-store");

    const html = await res.text();
    // Artifact body present.
    expect(html).toContain("<h1>Preview Body Marker</h1>");
    // inputData embedded in the inert shim, before the body.
    expect(html).toContain('"prTitle":"Ship it"');
    expect(html).toContain('"count":3');
    // window.pane shim is present.
    expect(html).toContain("window.pane");
    // No live runtime / WebSocket.
    expect(html).not.toContain("WebSocket");
  });

  it("a pane with NO input_data embeds null", async () => {
    const { agentId, humanId, cookie } =
      await seedHumanAgent("pv2@example.com");
    const { versionId } = await seedTemplate({ agentId });
    const paneId = await seedPane({ agentId, humanId, versionId });

    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/preview`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("var inputData = null;");
  });

  it("escapes inputData that contains </script> or < — no raw breakout", async () => {
    const { agentId, humanId, cookie } =
      await seedHumanAgent("pv3@example.com");
    const { versionId } = await seedTemplate({ agentId });
    const paneId = await seedPane({
      agentId,
      humanId,
      versionId,
      inputData: {
        evil: "</script><script>window.__x=1</script>",
        lt: "<div>raw</div>",
      },
    });

    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/preview`, withCookie(cookie)),
    );
    const html = await res.text();
    // The embedded literal must NOT contain a raw closing script tag from the
    // attacker-controlled value (only the legitimate </script> closing our own
    // shim block survives).
    // Our shim is the only <script> in <head>; count closers — there must be
    // exactly the ones we emit (shim close), not an injected one.
    const injected = html.includes("</script><script>window.__x=1");
    expect(injected).toBe(false);
    // The escaped form is present instead. Only `<` is markup-significant inside
    // a <script> (it starts `</script>` / `<!--`); `>` is left as-is by
    // JSON.stringify + our escape, which is harmless. The neutralised `<` is
    // what prevents the breakout.
    expect(html).toContain("\\u003c/script>");
    expect(html).toContain("\\u003cdiv>raw\\u003c/div>");
  });

  it("non-owner human → 404", async () => {
    const { agentId, humanId } = await seedHumanAgent("pv4@example.com");
    const stranger = await seedHumanAgent("pv4b@example.com");
    const { versionId } = await seedTemplate({ agentId });
    const paneId = await seedPane({ agentId, humanId, versionId });

    const res = await app.fetch(
      new Request(
        `http://t/panes/${paneId}/preview`,
        withCookie(stranger.cookie),
      ),
    );
    expect(res.status).toBe(404);
  });

  it("unknown id → 404", async () => {
    const { cookie } = await seedHumanAgent("pv5@example.com");
    const res = await app.fetch(
      new Request(
        "http://t/panes/pane_does_not_exist/preview",
        withCookie(cookie),
      ),
    );
    expect(res.status).toBe(404);
  });

  it("non-html-inline template renders a placeholder body, not an error", async () => {
    const { agentId, humanId, cookie } =
      await seedHumanAgent("pv6@example.com");
    const { versionId } = await seedTemplate({
      agentId,
      templateType: "html-ref",
      source: "https://example.com/x",
    });
    const paneId = await seedPane({ agentId, humanId, versionId });
    const res = await app.fetch(
      new Request(`http://t/panes/${paneId}/preview`, withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("html-ref is not implemented");
  });
});

describe("GET /templates/:id/preview", () => {
  it("owner → 200 with latest source + inputData null", async () => {
    const { agentId, cookie } = await seedHumanAgent("tp1@example.com");
    const { templateId } = await seedTemplate({
      agentId,
      source: "<main>Template Latest Marker</main>",
    });
    const res = await app.fetch(
      new Request(
        `http://t/templates/${templateId}/preview`,
        withCookie(cookie),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<main>Template Latest Marker</main>");
    expect(html).toContain("var inputData = null;");
  });

  it("non-owner human → 404 on unpublished, 200 on published", async () => {
    const { agentId } = await seedHumanAgent("tp2@example.com");
    const stranger = await seedHumanAgent("tp2b@example.com");
    const { templateId } = await seedTemplate({ agentId });

    let res = await app.fetch(
      new Request(
        `http://t/templates/${templateId}/preview`,
        withCookie(stranger.cookie),
      ),
    );
    expect(res.status).toBe(404);

    await prisma.template.update({
      where: { id: templateId },
      data: { publishedAt: new Date() },
    });
    res = await app.fetch(
      new Request(
        `http://t/templates/${templateId}/preview`,
        withCookie(stranger.cookie),
      ),
    );
    expect(res.status).toBe(200);
  });

  it("an installer (not owner) of an unpublished template → 200", async () => {
    const { agentId } = await seedHumanAgent("tp3@example.com");
    const installer = await seedHumanAgent("tp3b@example.com");
    const { templateId } = await seedTemplate({ agentId });
    await prisma.humanTemplateInstall.create({
      data: {
        humanId: installer.humanId,
        templateId,
        installedVersion: 1,
      },
    });
    const res = await app.fetch(
      new Request(
        `http://t/templates/${templateId}/preview`,
        withCookie(installer.cookie),
      ),
    );
    expect(res.status).toBe(200);
  });

  it("unknown id → 404", async () => {
    const { cookie } = await seedHumanAgent("tp4@example.com");
    const res = await app.fetch(
      new Request("http://t/templates/tmpl_nope/preview", withCookie(cookie)),
    );
    expect(res.status).toBe(404);
  });
});

describe("owner-shell SPA — tile-preview iframe placement", () => {
  it("big monogram cards get a tile-preview iframe; emoji/image cards + pane rows do not", async () => {
    const { agentId, humanId, cookie } =
      await seedHumanAgent("sp1@example.com");

    // Template A — no icon → monogram → app-tile gets a preview iframe.
    const { templateId: plainId } = await seedTemplate({ agentId });

    // Template B — emoji icon → NO preview iframe.
    const { templateId: emojiId } = await seedTemplate({
      agentId,
      iconEmoji: "🌟",
    });

    // Template C — image icon → NO preview iframe.
    const imgAtt = await seedReadyImage({
      ownerId: agentId,
      scope: "template",
    });
    const { templateId: imgId } = await seedTemplate({
      agentId,
      iconAttachmentId: imgAtt,
    });

    // A favorited pane (no icon) → favorites tile + pane row both render.
    const { versionId } = await seedTemplate({ agentId });
    const paneId = await seedPane({ agentId, humanId, versionId });
    await prisma.humanPaneFavorite.create({
      data: { humanId, paneId },
    });

    const res = await app.fetch(
      new Request("http://t/home", withCookie(cookie)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();

    // The plain template's app-tile carries a preview iframe pointing at its
    // /templates/:id/preview endpoint.
    expect(html).toContain('class="tile-preview"');
    expect(html).toContain(`src="/templates/${plainId}/preview"`);

    // The favorited pane's big tile carries a pane preview iframe.
    expect(html).toContain(`src="/panes/${paneId}/preview"`);

    // Emoji + image tiles do NOT get a preview iframe.
    expect(html).not.toContain(`src="/templates/${emojiId}/preview"`);
    expect(html).not.toContain(`src="/templates/${imgId}/preview"`);

    // The 44px pane-row keeps the monogram (no iframe in the row). The row's
    // icon is a .tile-monogram with no adjacent tile-preview iframe — assert the
    // monogram is still emitted for the pane.
    expect(html).toContain('class="tile-monogram"');
  });
});
