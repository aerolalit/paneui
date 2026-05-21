// End-to-end test for `GET /s/:participantToken/blobs/:blob_id` — follow-up
// D of #156. The symmetric counterpart to the upload bridge test.
//
// What we exercise here:
//   * Happy paths (blob referenced from an event; from session inputData;
//     agent-scope blob referenced from an event payload).
//   * Authn (malformed / unknown / revoked token -> 401).
//   * Authz (token from session A used to fetch a blob only referenced in
//     session B -> 404; valid-shape but unreferenced blob_id -> 404;
//     soft-deleted blob -> 404; nonexistent blob_id -> 404).
//   * Input validation (malformed blob_id shape -> 400).
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
import { seedSessionRow } from "../test-helpers/seed.js";
import { createPrismaClient } from "../db.js";
import { loadConfig } from "../config.js";
import { hashKey, keyPrefix, generateHumanParticipantToken } from "../keys.js";
import { buildApp } from "../http/app.js";
import { makeBlobStore } from "../blobs/index.js";

let testDb: TestDb;
let plainApp: Hono;
let encryptedApp: Hono;
let prisma: PrismaClient;
let plainBlobDir: string;
let encryptedBlobDir: string;

// Schema that declares a blob ref in both an event payload AND an input
// schema. The download route must accept refs reachable through either site.
const blobEventSchema = {
  events: {
    "image.attached": {
      payload: {
        type: "object",
        properties: {
          blob: {
            type: "object",
            properties: {
              blob_id: { type: "string", format: "pane-blob-id" },
              mime: { type: "string" },
            },
            required: ["blob_id"],
          },
        },
        required: ["blob"],
        additionalProperties: false,
      },
      emittedBy: ["agent", "page"],
    },
    // A "plain" event used by the negative tests — no blob refs at all.
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
        blob_id: { type: "string", format: "pane-blob-id" },
      },
      required: ["blob_id"],
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
  plainBlobDir = mkdtempSync(join(tmpdir(), "blob-download-e2e-"));
  encryptedBlobDir = mkdtempSync(join(tmpdir(), "blob-download-e2e-enc-"));

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
  sessionId: string;
  participantToken: string;
}

async function seedSession(
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
  const { sessionId } = await seedSessionRow(prisma, {
    agentId: agent.id,
    artifactSource: "<html></html>",
    eventSchema: blobEventSchema,
    inputSchema: opts.inputSchema ?? undefined,
    inputData: opts.inputData ?? undefined,
    status: "open",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const token = generateHumanParticipantToken();
  await prisma.participant.create({
    data: {
      sessionId,
      kind: "human",
      identityId: "human-1",
      tokenHash: hashKey(token),
      tokenPrefix: keyPrefix(token),
    },
  });
  return {
    agentId: agent.id,
    agentApiKey: apiKey,
    sessionId,
    participantToken: token,
  };
}

/** Upload a blob via the agent's POST /v1/blobs route. Returns the BlobRef. */
async function agentUploadBlob(
  app: Hono,
  apiKey: string,
  bytes: Buffer,
  scope: "agent" | "session" = "agent",
  sessionId: string | null = null,
): Promise<{ blob_id: string; sha256: string; size: number }> {
  const fd = new FormData();
  fd.set("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
  fd.set("scope", scope);
  if (scope === "session" && sessionId) fd.set("session_id", sessionId);
  const res = await app.fetch(
    new Request("http://t/v1/blobs", {
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
    blob_id: string;
    sha256: string;
    size: number;
  };
}

/** Emit an event via the agent's POST /v1/sessions/:id/events route. */
async function agentEmitEvent(
  app: Hono,
  apiKey: string,
  sessionId: string,
  type: string,
  data: unknown,
): Promise<void> {
  const res = await app.fetch(
    new Request(`http://t/v1/sessions/${sessionId}/events`, {
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

function getDownloadUrl(token: string, blobId: string): string {
  return `http://t/s/${token}/blobs/${blobId}`;
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("GET /s/:participantToken/blobs/:blob_id — happy paths", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the bytes when the blob is referenced from an event in the session", async () => {
    const { agentApiKey, sessionId, participantToken } = await seedSession();
    const bytes = await makeJpeg(256);
    const { blob_id, sha256, size } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "session",
      sessionId,
    );

    await agentEmitEvent(plainApp, agentApiKey, sessionId, "image.attached", {
      blob: { blob_id, mime: "image/jpeg" },
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, blob_id)),
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

  it("returns the bytes when the blob is referenced from session inputData", async () => {
    // First upload an agent-scope blob outside any session, then create the
    // session with inputData referencing it.
    const apiKey = "pane_" + randomBytes(16).toString("hex");
    const agent = await prisma.agent.create({
      data: {
        name: "input-data-agent",
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
      },
    });
    const bytes = await makeJpeg(256);
    const { blob_id, sha256 } = await agentUploadBlob(plainApp, apiKey, bytes);

    // Now seed a session that pins this blob in inputData. We use the seed
    // helper directly because POST /v1/sessions has its own access check;
    // seeding bypasses validation but we WANT a sane inputData here.
    const { sessionId } = await seedSessionRow(prisma, {
      agentId: agent.id,
      eventSchema: blobEventSchema,
      inputSchema: blobInputSchema,
      inputData: { cover: { blob_id } },
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const token = generateHumanParticipantToken();
    await prisma.participant.create({
      data: {
        sessionId,
        kind: "human",
        identityId: "human-1",
        tokenHash: hashKey(token),
        tokenPrefix: keyPrefix(token),
      },
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(token, blob_id)),
    );
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(got).digest("hex")).toBe(sha256);
  });

  it("returns the bytes for an agent-scope blob referenced from an event in the session", async () => {
    // An agent-scope blob (uploaded with no session FK) referenced from an
    // event in this session is reachable — the authz rule is "is this id
    // referenced from THIS session?", not "does this blob belong to this
    // session's scope".
    const { agentApiKey, sessionId, participantToken } = await seedSession();
    const bytes = await makeJpeg(256);
    const { blob_id, sha256 } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "agent",
    );

    await agentEmitEvent(plainApp, agentApiKey, sessionId, "image.attached", {
      blob: { blob_id, mime: "image/jpeg" },
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, blob_id)),
    );
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(got).digest("hex")).toBe(sha256);
  });
});

// ---------------------------------------------------------------------------
// Authn — token validation
// ---------------------------------------------------------------------------

describe("GET /s/:participantToken/blobs/:blob_id — auth / token validation", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects a malformed token with 401 participant_token_invalid", async () => {
    const res = await plainApp.fetch(
      new Request("http://t/s/not-a-real-token/blobs/aaaaaaaaaaaaaaaaaaaaa"),
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
    const { participantToken, sessionId } = await seedSession();
    await prisma.participant.updateMany({
      where: { sessionId },
      data: { revokedAt: new Date() },
    });
    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, "aaaaaaaaaaaaaaaaaaaaa")),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("participant_token_invalid");
  });

  it("rejects downloads against a closed session with 410 gone", async () => {
    const { participantToken, sessionId } = await seedSession();
    await prisma.session.update({
      where: { id: sessionId },
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
// Authz — referenced-from-this-session check
// ---------------------------------------------------------------------------

describe("GET /s/:participantToken/blobs/:blob_id — authz", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects a token from session A used to download a blob only referenced in session B with 404", async () => {
    // Session A — has the blob referenced.
    const a = await seedSession();
    const bytes = await makeJpeg(256);
    const { blob_id } = await agentUploadBlob(
      plainApp,
      a.agentApiKey,
      bytes,
      "session",
      a.sessionId,
    );
    await agentEmitEvent(
      plainApp,
      a.agentApiKey,
      a.sessionId,
      "image.attached",
      { blob: { blob_id, mime: "image/jpeg" } },
    );

    // Session B — same agent, different session, never references the blob.
    const { sessionId: sessionBId } = await seedSessionRow(prisma, {
      agentId: a.agentId,
      eventSchema: blobEventSchema,
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const tokenB = generateHumanParticipantToken();
    await prisma.participant.create({
      data: {
        sessionId: sessionBId,
        kind: "human",
        identityId: "human-2",
        tokenHash: hashKey(tokenB),
        tokenPrefix: keyPrefix(tokenB),
      },
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(tokenB, blob_id)),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_ref_not_accessible");
  });

  it("rejects a blob_id of correct shape but not referenced in this session with 404", async () => {
    // Seed a blob the agent owns but the session never references.
    const { agentApiKey, participantToken } = await seedSession();
    const bytes = await makeJpeg(256);
    const { blob_id } = await agentUploadBlob(plainApp, agentApiKey, bytes);
    // No event emitted, no inputData reference — the session has no
    // pointer to this blob.

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, blob_id)),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_ref_not_accessible");
  });

  it("rejects a soft-deleted blob with 404 even when previously referenced", async () => {
    const { agentApiKey, sessionId, participantToken } = await seedSession();
    const bytes = await makeJpeg(256);
    const { blob_id } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "session",
      sessionId,
    );
    await agentEmitEvent(plainApp, agentApiKey, sessionId, "image.attached", {
      blob: { blob_id, mime: "image/jpeg" },
    });

    // Soft-delete the blob.
    await prisma.blob.update({
      where: { id: blob_id },
      data: { status: "deleted", deletedAt: new Date() },
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, blob_id)),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_ref_not_accessible");
  });

  it("rejects a nonexistent blob_id of correct shape with 404", async () => {
    const { participantToken } = await seedSession();
    // A cuid-ish shape that doesn't correspond to any row.
    const fake = "ckabcd0123456789abcdef01";
    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, fake)),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_ref_not_accessible");
  });

  it("rejects a malformed blob_id with 400 invalid_request", async () => {
    const { participantToken } = await seedSession();
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

describe("GET /s/:participantToken/blobs/:blob_id — envelope encryption", () => {
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
    const { sessionId } = await seedSessionRow(prisma, {
      agentId: agent.id,
      eventSchema: blobEventSchema,
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const token = generateHumanParticipantToken();
    await prisma.participant.create({
      data: {
        sessionId,
        kind: "human",
        identityId: "human-1",
        tokenHash: hashKey(token),
        tokenPrefix: keyPrefix(token),
      },
    });

    // Upload through the encrypted app — bytes on disk will be ciphertext.
    const plaintext = await makeJpeg(512);
    const { blob_id, sha256: plaintextSha } = await agentUploadBlob(
      encryptedApp,
      apiKey,
      plaintext,
      "session",
      sessionId,
    );

    // Emit an event so the blob is referenced by the session.
    await agentEmitEvent(encryptedApp, apiKey, sessionId, "image.attached", {
      blob: { blob_id, mime: "image/jpeg" },
    });

    // The on-disk file is ciphertext.
    const row = await prisma.blob.findUnique({ where: { id: blob_id } });
    expect(row?.encryptionEnvelope).toBeTruthy();
    const storagePath = join(encryptedBlobDir, `blob_${blob_id}`);
    const onDisk = readFileSync(storagePath);
    const onDiskSha = createHash("sha256").update(onDisk).digest("hex");
    expect(onDiskSha).not.toBe(plaintextSha);

    // The download route returns the plaintext bytes.
    const res = await encryptedApp.fetch(
      new Request(getDownloadUrl(token, blob_id)),
    );
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(got).digest("hex")).toBe(plaintextSha);
  });
});
