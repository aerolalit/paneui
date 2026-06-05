// F-02 regression suite — identity-bound participant token enforcement.
//
// `POST /v1/panes/:id/identity-link` mints a `tok_h_…` token bound to a
// specific human (`participant.humanId`). The intended contract: ONLY the
// bound human, AFTER logging in, may use that URL. The binding used to be
// enforced in exactly one place (the shell HTML page); every other consumer
// of the same token (content, events, records, attachments, ws-ticket, WS
// upgrade) checked only `revokedAt` and ignored the binding — so anyone
// holding the raw token could read/write as the bound human without ever
// logging in.
//
// These tests assert that EVERY HTTP consumer now rejects an identity-bound
// token presented without the matching `pane_login` cookie (anonymous, or
// logged in as a different human), accepts it WITH the correct cookie, and
// that anonymous (humanId-null) tokens keep working with no cookie at all.
//
// The WS-upgrade path is covered separately in src/ws/handler.e2e.test.ts
// (it needs the real node:http server, not app.fetch).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { AttachmentStore } from "../../attachments/store.js";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import {
  hashKey,
  keyPrefix,
  generateHumanParticipantToken,
} from "../../keys.js";
import { buildApp } from "../app.js";
import { makeBlobStore } from "../../attachments/index.js";
import {
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
} from "../../auth/cookie.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;
let blobDir: string;
let blobStore: AttachmentStore;

// Event schema with one page-emittable event so an identity-bound participant
// can attempt to author an event.
const eventSchema = {
  events: {
    "review.commentAdded": {
      payload: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
      emittedBy: ["page", "agent"],
    },
  },
};

// Record schema with one page-writable collection.
const recordSchema = {
  $defs: {
    Comment: {
      type: "object",
      properties: { body: { type: "string", minLength: 1 } },
      required: ["body"],
    },
  },
  "x-pane-collections": {
    comments: {
      schema: { $ref: "#/$defs/Comment" },
      write: ["page", "agent"],
      delete: ["agent", "author"],
    },
  },
};

beforeAll(async () => {
  blobDir = mkdtempSync(join(tmpdir(), "identity-binding-e2e-"));
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
    BLOB_MIME_ALLOWLIST: "image/jpeg,image/png,application/pdf",
  });
  const store = await makeBlobStore(config);
  if (!store) throw new Error("expected a filesystem blob store");
  blobStore = store;
  app = buildApp(config, prisma, undefined, blobStore);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
  rmSync(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedLogin(
  email: string,
): Promise<{ humanId: string; cookie: string }> {
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
  return { humanId: human.id, cookie };
}

async function seedAgentPane(): Promise<{ agentId: string; paneId: string }> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey("pane_" + randomBytes(16).toString("hex")),
      keyPrefix: "p",
    },
  });
  const template = await prisma.template.create({
    data: { ownerId: agent.id, name: "t", latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>secret body</p>",
      eventSchema,
      recordSchema,
    },
  });
  const pane = await prisma.pane.create({
    data: {
      id: `pan_${randomBytes(8).toString("hex")}`,
      agentId: agent.id,
      templateVersionId: version.id,
      title: "test",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return { agentId: agent.id, paneId: pane.id };
}

// Mint a participant token directly so the tests don't depend on the
// identity-link route's response shape. `humanId` null = anonymous capability.
async function mintToken(
  paneId: string,
  identitySuffix: string,
  humanId: string | null,
): Promise<string> {
  const token = generateHumanParticipantToken();
  await prisma.participant.create({
    data: {
      paneId,
      kind: "human",
      identityId: `h_${identitySuffix}`,
      tokenHash: hashKey(token),
      tokenPrefix: keyPrefix(token),
      ...(humanId ? { humanId } : {}),
    },
  });
  return token;
}

// Seed a pane-scoped, ready attachment owned by the pane's agent. Branch (b)
// of the download bridge (scope=pane && paneId match) makes it reachable
// without needing it referenced from an event.
async function seedPaneAttachment(
  agentId: string,
  paneId: string,
): Promise<string> {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]); // tiny JPEG-ish
  const id = `att${randomBytes(10).toString("hex")}`;
  // Flat key — the FilesystemBlobStore maps the key straight onto a path under
  // its root (join(dir, key)) and does not create nested directories, so the
  // key must not contain path separators.
  const storageKey = `att_${id}`;
  // Write the bytes through the SAME store the app reads from so the download
  // bridge's store.get(storageKey) returns content. No encryption-at-rest in
  // this config, so the stored bytes are the plaintext bytes.
  const info = await blobStore.put(storageKey, Readable.from(bytes), {
    mime: "image/jpeg",
    maxBytes: 1024,
  });
  await prisma.attachment.create({
    data: {
      id,
      ownerId: agentId,
      scope: "pane",
      paneId,
      mime: "image/jpeg",
      size: info.size,
      sha256: info.sha256,
      status: "ready",
      storageKey,
    },
  });
  return id;
}

function cookieHeader(cookie: string): Record<string, string> {
  return { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` };
}

function jpegForm(): FormData {
  const fd = new FormData();
  const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  fd.set(
    "file",
    new Blob([new Uint8Array(body)], { type: "image/jpeg" }),
    "x.jpg",
  );
  return fd;
}

// ---------------------------------------------------------------------------
// GET /s/:token/content
// ---------------------------------------------------------------------------

describe("identity binding — GET /s/:token/content", () => {
  it("rejects an identity-bound token with no cookie (404)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    expect(res.status).toBe(404);
  });

  it("rejects an identity-bound token with a different human's cookie (404)", async () => {
    const bob = await seedLogin("bob@example.com");
    const eve = await seedLogin("eve@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/s/${token}/content`, {
        headers: cookieHeader(eve.cookie),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("serves the body with the bound human's cookie (200)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/s/${token}/content`, {
        headers: cookieHeader(bob.cookie),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("secret body");
  });

  it("serves an anonymous token with no cookie (regression guard)", async () => {
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", null);
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /s/:token/presence
// ---------------------------------------------------------------------------

describe("identity binding — GET /s/:token/presence", () => {
  it("rejects an identity-bound token with no cookie (404)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(new Request(`http://t/s/${token}/presence`));
    expect(res.status).toBe(404);
  });

  it("serves presence with the bound human's cookie (200)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/s/${token}/presence`, {
        headers: cookieHeader(bob.cookie),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("serves an anonymous token with no cookie (regression guard)", async () => {
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", null);
    const res = await app.fetch(new Request(`http://t/s/${token}/presence`));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/panes/:id/events (Bearer participant token, via dualAuth)
// ---------------------------------------------------------------------------

function emitBody(): string {
  return JSON.stringify({
    type: "review.commentAdded",
    data: { body: "hi" },
  });
}

describe("identity binding — POST /v1/panes/:id/events", () => {
  it("rejects an identity-bound token with no cookie (404)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: emitBody(),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects an identity-bound token with a different human's cookie (404)", async () => {
    const bob = await seedLogin("bob@example.com");
    const eve = await seedLogin("eve@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...cookieHeader(eve.cookie),
        },
        body: emitBody(),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("accepts the event with the bound human's cookie (201)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...cookieHeader(bob.cookie),
        },
        body: emitBody(),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("accepts an anonymous token with no cookie (regression guard)", async () => {
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", null);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: emitBody(),
      }),
    );
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Records read + write (GET / POST /v1/panes/:id/records/:collection)
// ---------------------------------------------------------------------------

describe("identity binding — records read/write", () => {
  it("rejects record read with no cookie (404)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/records/comments`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects record write with no cookie (404)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/records/comments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ data: { body: "x" } }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("allows record read with the bound human's cookie (200)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/records/comments`, {
        headers: {
          authorization: `Bearer ${token}`,
          ...cookieHeader(bob.cookie),
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("allows anonymous record read with no cookie (regression guard)", async () => {
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", null);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/records/comments`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/panes/:id/ws-ticket (via dualAuth)
// ---------------------------------------------------------------------------

describe("identity binding — POST /v1/panes/:id/ws-ticket", () => {
  it("rejects an identity-bound token with no cookie (404)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/ws-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("mints a ticket with the bound human's cookie (200/201)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/ws-ticket`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...cookieHeader(bob.cookie),
        },
      }),
    );
    expect([200, 201]).toContain(res.status);
  });

  it("mints a ticket for an anonymous token with no cookie (regression guard)", async () => {
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", null);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}/ws-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect([200, 201]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Attachment upload (POST /s/:token/attachments) +
// download (GET /s/:token/attachments/:id)
// ---------------------------------------------------------------------------

describe("identity binding — attachments", () => {
  it("rejects upload with no cookie (401 participant_token_invalid)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/s/${token}/attachments`, {
        method: "POST",
        body: jpegForm(),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("participant_token_invalid");
  });

  it("rejects upload with a different human's cookie (401)", async () => {
    const bob = await seedLogin("bob@example.com");
    const eve = await seedLogin("eve@example.com");
    const { paneId } = await seedAgentPane();
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/s/${token}/attachments`, {
        method: "POST",
        headers: cookieHeader(eve.cookie),
        body: jpegForm(),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects download with no cookie (401)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { agentId, paneId } = await seedAgentPane();
    const attId = await seedPaneAttachment(agentId, paneId);
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/s/${token}/attachments/${attId}`),
    );
    expect(res.status).toBe(401);
  });

  it("allows download with the bound human's cookie (200)", async () => {
    const bob = await seedLogin("bob@example.com");
    const { agentId, paneId } = await seedAgentPane();
    const attId = await seedPaneAttachment(agentId, paneId);
    const token = await mintToken(paneId, "0", bob.humanId);
    const res = await app.fetch(
      new Request(`http://t/s/${token}/attachments/${attId}`, {
        headers: cookieHeader(bob.cookie),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("allows anonymous download with no cookie (regression guard)", async () => {
    const { agentId, paneId } = await seedAgentPane();
    const attId = await seedPaneAttachment(agentId, paneId);
    const token = await mintToken(paneId, "0", null);
    const res = await app.fetch(
      new Request(`http://t/s/${token}/attachments/${attId}`),
    );
    expect(res.status).toBe(200);
  });
});
