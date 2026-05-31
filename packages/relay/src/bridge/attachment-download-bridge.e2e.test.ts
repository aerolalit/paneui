// End-to-end test for `GET /s/:participantToken/attachments/:attachment_id` — follow-up
// D of #156. The symmetric counterpart to the upload bridge test.
//
// What we exercise here:
//   * Happy paths (attachment referenced from an event; from surface inputData;
//     agent-scope attachment referenced from an event payload).
//   * Authn (malformed / unknown / revoked token -> 401).
//   * Authz (token from surface A used to fetch a attachment only referenced in
//     surface B -> 404; valid-shape but unreferenced attachment_id -> 404;
//     soft-deleted attachment -> 404; nonexistent attachment_id -> 404).
//   * Input validation (malformed attachment_id shape -> 400).
//   * Encryption-at-rest round trip: on-disk ciphertext differs from
//     plaintext, the route returns plaintext bytes.
//   * Response headers (Cache-Control: private, no-store).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { seedSurfaceRow } from "../test-helpers/seed.js";
import { createPrismaClient } from "../db.js";
import { loadConfig } from "../config.js";
import { hashKey, keyPrefix, generateHumanParticipantToken } from "../keys.js";
import { buildApp } from "../http/app.js";
import { makeBlobStore } from "../attachments/index.js";

let testDb: TestDb;
let plainApp: Hono;
let encryptedApp: Hono;
let prisma: PrismaClient;
let plainBlobDir: string;
let encryptedBlobDir: string;

// Schema that declares a attachment ref in both an event payload AND an input
// schema. The download route must accept refs reachable through either site.
const blobEventSchema = {
  events: {
    "image.attached": {
      payload: {
        type: "object",
        properties: {
          attachment: {
            type: "object",
            properties: {
              attachment_id: { type: "string", format: "pane-attachment-id" },
              mime: { type: "string" },
            },
            required: ["attachment_id"],
          },
        },
        required: ["attachment"],
        additionalProperties: false,
      },
      emittedBy: ["agent", "page"],
    },
    // A "plain" event used by the negative tests — no attachment refs at all.
    "review.commentAdded": {
      payload: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
      emittedBy: ["agent", "page"],
    },
  },
};

const blobInputSchema = {
  type: "object",
  properties: {
    cover: {
      type: "object",
      properties: {
        attachment_id: { type: "string", format: "pane-attachment-id" },
      },
      required: ["attachment_id"],
    },
  },
};

async function makeJpeg(approxBytes = 256): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const d = Math.max(8, Math.round(Math.sqrt(approxBytes)));
  return sharp({
    create: {
      width: d,
      height: d,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

beforeAll(async () => {
  plainBlobDir = mkdtempSync(join(tmpdir(), "attachment-download-e2e-"));
  encryptedBlobDir = mkdtempSync(
    join(tmpdir(), "attachment-download-e2e-enc-"),
  );

  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);

  // Plain (no encryption) app — used for the bulk of happy/auth tests so the
  // assertions don't need to think about envelope semantics.
  const plainConfig = loadConfig({
    DATABASE_URL: testDb.dbUrl,
    PUBLIC_URL: "http://localhost:3000",
    BLOB_STORE: "filesystem",
    BLOB_STORE_FS_DIR: plainBlobDir,
    BLOB_MIME_ALLOWLIST: "image/jpeg,image/png,application/pdf",
  });
  const plainStore = await makeBlobStore(plainConfig);
  plainApp = buildApp(plainConfig, prisma, undefined, plainStore);

  // Encrypted-at-rest app — used for the round-trip decrypt assertion.
  const encConfig = loadConfig({
    DATABASE_URL: testDb.dbUrl,
    PUBLIC_URL: "http://localhost:3000",
    BLOB_STORE: "filesystem",
    BLOB_STORE_FS_DIR: encryptedBlobDir,
    BLOB_MIME_ALLOWLIST: "image/jpeg",
    BLOB_ENCRYPT_AT_REST: "true",
  });
  const encStore = await makeBlobStore(encConfig);
  encryptedApp = buildApp(encConfig, prisma, undefined, encStore);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
  rmSync(plainBlobDir, { recursive: true, force: true });
  rmSync(encryptedBlobDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeededSession {
  agentId: string;
  agentApiKey: string;
  surfaceId: string;
  participantToken: string;
}

async function seedSurface(
  opts: { inputData?: object | null; inputSchema?: object | null } = {},
): Promise<SeededSession> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  const { surfaceId } = await seedSurfaceRow(prisma, {
    agentId: agent.id,
    templateSource: "<html></html>",
    eventSchema: blobEventSchema,
    inputSchema: opts.inputSchema ?? undefined,
    inputData: opts.inputData ?? undefined,
    status: "open",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const token = generateHumanParticipantToken();
  await prisma.participant.create({
    data: {
      surfaceId,
      kind: "human",
      identityId: "human-1",
      tokenHash: hashKey(token),
      tokenPrefix: keyPrefix(token),
    },
  });
  return {
    agentId: agent.id,
    agentApiKey: apiKey,
    surfaceId,
    participantToken: token,
  };
}

/** Upload a attachment via the agent's POST /v1/attachments route. Returns the AttachmentRef. */
async function agentUploadBlob(
  app: Hono,
  apiKey: string,
  bytes: Buffer,
  scope: "agent" | "surface" = "agent",
  surfaceId: string | null = null,
): Promise<{ attachment_id: string; sha256: string; size: number }> {
  const fd = new FormData();
  fd.set("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
  fd.set("scope", scope);
  if (scope === "surface" && surfaceId) fd.set("surface_id", surfaceId);
  const res = await app.fetch(
    new Request("http://t/v1/attachments", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: fd,
    }),
  );
  if (res.status !== 201) {
    throw new Error(
      `agentUploadBlob: expected 201, got ${res.status}: ${await res.text()}`,
    );
  }
  return (await res.json()) as {
    attachment_id: string;
    sha256: string;
    size: number;
  };
}

/** Emit an event via the agent's POST /v1/surfaces/:id/events route. */
async function agentEmitEvent(
  app: Hono,
  apiKey: string,
  surfaceId: string,
  type: string,
  data: unknown,
): Promise<void> {
  const res = await app.fetch(
    new Request(`http://t/v1/surfaces/${surfaceId}/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type, data }),
    }),
  );
  if (res.status !== 201) {
    throw new Error(
      `agentEmitEvent: expected 201, got ${res.status}: ${await res.text()}`,
    );
  }
}

function getDownloadUrl(token: string, attachmentId: string): string {
  return `http://t/s/${token}/attachments/${attachmentId}`;
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("GET /s/:participantToken/attachments/:attachment_id — happy paths", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the bytes when the attachment is referenced from an event in the surface", async () => {
    const { agentApiKey, surfaceId, participantToken } = await seedSurface();
    const bytes = await makeJpeg(256);
    const { attachment_id, sha256, size } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "surface",
      surfaceId,
    );

    await agentEmitEvent(plainApp, agentApiKey, surfaceId, "image.attached", {
      attachment: { attachment_id, mime: "image/jpeg" },
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, attachment_id)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-length")).toBe(String(size));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const got = Buffer.from(await res.arrayBuffer());
    const gotSha = createHash("sha256").update(got).digest("hex");
    expect(gotSha).toBe(sha256);
  });

  it("returns the bytes when the attachment is referenced from surface inputData", async () => {
    // First upload an agent-scope attachment outside any surface, then create the
    // surface with inputData referencing it.
    const apiKey = "pane_" + randomBytes(16).toString("hex");
    const agent = await prisma.agent.create({
      data: {
        name: "input-data-agent",
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
      },
    });
    const bytes = await makeJpeg(256);
    const { attachment_id, sha256 } = await agentUploadBlob(
      plainApp,
      apiKey,
      bytes,
    );

    // Now seed a surface that pins this attachment in inputData. We use the seed
    // helper directly because POST /v1/surfaces has its own access check;
    // seeding bypasses validation but we WANT a sane inputData here.
    const { surfaceId } = await seedSurfaceRow(prisma, {
      agentId: agent.id,
      eventSchema: blobEventSchema,
      inputSchema: blobInputSchema,
      inputData: { cover: { attachment_id } },
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const token = generateHumanParticipantToken();
    await prisma.participant.create({
      data: {
        surfaceId,
        kind: "human",
        identityId: "human-1",
        tokenHash: hashKey(token),
        tokenPrefix: keyPrefix(token),
      },
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(token, attachment_id)),
    );
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(got).digest("hex")).toBe(sha256);
  });

  it("returns the bytes for an agent-scope attachment referenced from an event in the surface", async () => {
    // An agent-scope attachment (uploaded with no surface FK) referenced from an
    // event in this surface is reachable — the authz rule is "is this id
    // referenced from THIS surface?", not "does this attachment belong to this
    // surface's scope".
    const { agentApiKey, surfaceId, participantToken } = await seedSurface();
    const bytes = await makeJpeg(256);
    const { attachment_id, sha256 } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "agent",
    );

    await agentEmitEvent(plainApp, agentApiKey, surfaceId, "image.attached", {
      attachment: { attachment_id, mime: "image/jpeg" },
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, attachment_id)),
    );
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(got).digest("hex")).toBe(sha256);
  });
});

// ---------------------------------------------------------------------------
// Authn — token validation
// ---------------------------------------------------------------------------

describe("GET /s/:participantToken/attachments/:attachment_id — auth / token validation", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects a malformed token with 401 participant_token_invalid", async () => {
    const res = await plainApp.fetch(
      new Request(
        "http://t/s/not-a-real-token/attachments/aaaaaaaaaaaaaaaaaaaaa",
      ),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("participant_token_invalid");
  });

  it("rejects a well-formed but unknown token with 401", async () => {
    const bogus = generateHumanParticipantToken();
    const res = await plainApp.fetch(
      new Request(getDownloadUrl(bogus, "aaaaaaaaaaaaaaaaaaaaa")),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("participant_token_invalid");
  });

  it("rejects a revoked participant with 401", async () => {
    const { participantToken, surfaceId } = await seedSurface();
    await prisma.participant.updateMany({
      where: { surfaceId },
      data: { revokedAt: new Date() },
    });
    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, "aaaaaaaaaaaaaaaaaaaaa")),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("participant_token_invalid");
  });

  it("rejects downloads against a closed surface with 410 gone", async () => {
    const { participantToken, surfaceId } = await seedSurface();
    await prisma.surface.update({
      where: { id: surfaceId },
      data: { status: "closed" },
    });
    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, "aaaaaaaaaaaaaaaaaaaaa")),
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("gone");
  });
});

// ---------------------------------------------------------------------------
// Authz — referenced-from-this-surface check
// ---------------------------------------------------------------------------

describe("GET /s/:participantToken/attachments/:attachment_id — authz", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects a token from surface A used to download a attachment only referenced in surface B with 404", async () => {
    // Surface A — has the attachment referenced.
    const a = await seedSurface();
    const bytes = await makeJpeg(256);
    const { attachment_id } = await agentUploadBlob(
      plainApp,
      a.agentApiKey,
      bytes,
      "surface",
      a.surfaceId,
    );
    await agentEmitEvent(
      plainApp,
      a.agentApiKey,
      a.surfaceId,
      "image.attached",
      { attachment: { attachment_id, mime: "image/jpeg" } },
    );

    // Surface B — same agent, different surface, never references the attachment.
    const { surfaceId: sessionBId } = await seedSurfaceRow(prisma, {
      agentId: a.agentId,
      eventSchema: blobEventSchema,
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const tokenB = generateHumanParticipantToken();
    await prisma.participant.create({
      data: {
        surfaceId: sessionBId,
        kind: "human",
        identityId: "human-2",
        tokenHash: hashKey(tokenB),
        tokenPrefix: keyPrefix(tokenB),
      },
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(tokenB, attachment_id)),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_ref_not_accessible");
  });

  it("rejects a attachment_id of correct shape but not referenced in this surface with 404", async () => {
    // Seed a attachment the agent owns but the surface never references.
    const { agentApiKey, participantToken } = await seedSurface();
    const bytes = await makeJpeg(256);
    const { attachment_id } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
    );
    // No event emitted, no inputData reference — the surface has no
    // pointer to this attachment.

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, attachment_id)),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_ref_not_accessible");
  });

  it("rejects a soft-deleted attachment with 404 even when previously referenced", async () => {
    const { agentApiKey, surfaceId, participantToken } = await seedSurface();
    const bytes = await makeJpeg(256);
    const { attachment_id } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "surface",
      surfaceId,
    );
    await agentEmitEvent(plainApp, agentApiKey, surfaceId, "image.attached", {
      attachment: { attachment_id, mime: "image/jpeg" },
    });

    // Soft-delete the attachment.
    await prisma.attachment.update({
      where: { id: attachment_id },
      data: { status: "deleted", deletedAt: new Date() },
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, attachment_id)),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_ref_not_accessible");
  });

  it("rejects a nonexistent attachment_id of correct shape with 404", async () => {
    const { participantToken } = await seedSurface();
    // A cuid-ish shape that doesn't correspond to any row.
    const fake = "ckabcd0123456789abcdef01";
    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, fake)),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_ref_not_accessible");
  });

  it("rejects a malformed attachment_id with 400 invalid_request", async () => {
    const { participantToken } = await seedSurface();
    // Path-segment with disallowed chars but no slashes — Hono routes this
    // to the handler, which rejects on shape.
    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, "not_a_valid_blob_id!")),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });
});

// ---------------------------------------------------------------------------
// Encryption-at-rest round trip
// ---------------------------------------------------------------------------

describe("GET /s/:participantToken/attachments/:attachment_id — envelope encryption", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("on-disk ciphertext differs from plaintext; the route returns plaintext", async () => {
    const apiKey = "pane_" + randomBytes(16).toString("hex");
    const agent = await prisma.agent.create({
      data: {
        name: "enc-download-agent",
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
      },
    });
    const { surfaceId } = await seedSurfaceRow(prisma, {
      agentId: agent.id,
      eventSchema: blobEventSchema,
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const token = generateHumanParticipantToken();
    await prisma.participant.create({
      data: {
        surfaceId,
        kind: "human",
        identityId: "human-1",
        tokenHash: hashKey(token),
        tokenPrefix: keyPrefix(token),
      },
    });

    // Upload through the encrypted app — bytes on disk will be ciphertext.
    const plaintext = await makeJpeg(512);
    const { attachment_id, sha256: plaintextSha } = await agentUploadBlob(
      encryptedApp,
      apiKey,
      plaintext,
      "surface",
      surfaceId,
    );

    // Emit an event so the attachment is referenced by the surface.
    await agentEmitEvent(encryptedApp, apiKey, surfaceId, "image.attached", {
      attachment: { attachment_id, mime: "image/jpeg" },
    });

    // The on-disk file is ciphertext.
    const row = await prisma.attachment.findUnique({
      where: { id: attachment_id },
    });
    expect(row?.encryptionEnvelope).toBeTruthy();
    const storagePath = join(encryptedBlobDir, `attachment_${attachment_id}`);
    const onDisk = readFileSync(storagePath);
    const onDiskSha = createHash("sha256").update(onDisk).digest("hex");
    expect(onDiskSha).not.toBe(plaintextSha);

    // The download route returns the plaintext bytes.
    const res = await encryptedApp.fetch(
      new Request(getDownloadUrl(token, attachment_id)),
    );
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(got).digest("hex")).toBe(plaintextSha);
  });
});
