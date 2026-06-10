// End-to-end test for `GET /s/:participantToken/attachments/:attachment_id` — follow-up
// D of #156. The symmetric counterpart to the upload bridge test.
//
// What we exercise here:
//   * Happy paths (attachment referenced from an event; from pane inputData;
//     agent-scope attachment referenced from an event payload).
//   * Authn (malformed / unknown / revoked token -> 401).
//   * Authz (token from pane A used to fetch a attachment only referenced in
//     pane B -> 404; valid-shape but unreferenced attachment_id -> 404;
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
import { seedPaneRow } from "../test-helpers/seed.js";
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

interface SeededPane {
  agentId: string;
  agentApiKey: string;
  paneId: string;
  participantToken: string;
}

async function seedPane(
  opts: { inputData?: object | null; inputSchema?: object | null } = {},
): Promise<SeededPane> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  const { paneId } = await seedPaneRow(prisma, {
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
      paneId,
      kind: "human",
      identityId: "human-1",
      tokenHash: hashKey(token),
      tokenPrefix: keyPrefix(token),
    },
  });
  return {
    agentId: agent.id,
    agentApiKey: apiKey,
    paneId,
    participantToken: token,
  };
}

/** Upload a attachment via the agent's POST /v1/attachments route. Returns the AttachmentRef. */
async function agentUploadBlob(
  app: Hono,
  apiKey: string,
  bytes: Buffer,
  scope: "agent" | "pane" = "agent",
  paneId: string | null = null,
): Promise<{ attachment_id: string; sha256: string; size: number }> {
  const fd = new FormData();
  fd.set("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
  fd.set("scope", scope);
  if (scope === "pane" && paneId) fd.set("pane_id", paneId);
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

/** Emit an event via the agent's POST /v1/panes/:id/events route. */
async function agentEmitEvent(
  app: Hono,
  apiKey: string,
  paneId: string,
  type: string,
  data: unknown,
): Promise<void> {
  const res = await app.fetch(
    new Request(`http://t/v1/panes/${paneId}/events`, {
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

// #505 (B) — a record schema whose row carries an attachment_id. Used to prove
// an agent-owned attachment referenced ONLY from a record resolves on download.
const blobRecordSchema = {
  $defs: {
    Asset: {
      type: "object",
      properties: {
        attachment_id: { type: "string", format: "pane-attachment-id" },
      },
    },
  },
  "x-pane-collections": {
    assets: {
      schema: { $ref: "#/$defs/Asset" },
      write: ["agent", "page"],
      delete: ["agent"],
    },
  },
};

// Seed a pane whose template version declares a recordSchema (seedPaneRow
// doesn't carry recordSchema), returning the bits the record-download tests
// need.
async function seedPaneWithRecordSchema(): Promise<{
  agentApiKey: string;
  agentId: string;
  paneId: string;
  participantToken: string;
}> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `rec-agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  const template = await prisma.template.create({
    data: { ownerId: agent.id, name: "Record Download Test", latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
      eventSchema: blobEventSchema,
      recordSchema: blobRecordSchema,
    },
  });
  const paneId = `pan_${randomBytes(8).toString("hex")}`;
  await prisma.pane.create({
    data: {
      id: paneId,
      agentId: agent.id,
      templateVersionId: version.id,
      title: "record download test pane",
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const token = generateHumanParticipantToken();
  await prisma.participant.create({
    data: {
      paneId,
      kind: "human",
      identityId: "human-1",
      tokenHash: hashKey(token),
      tokenPrefix: keyPrefix(token),
    },
  });
  return {
    agentApiKey: apiKey,
    agentId: agent.id,
    paneId,
    participantToken: token,
  };
}

/** Write a record via the agent's POST /v1/panes/:id/records/:collection route. */
async function agentWriteRecord(
  app: Hono,
  apiKey: string,
  paneId: string,
  collection: string,
  data: unknown,
): Promise<void> {
  const res = await app.fetch(
    new Request(`http://t/v1/panes/${paneId}/records/${collection}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ data }),
    }),
  );
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `agentWriteRecord: expected 200/201, got ${res.status}: ${await res.text()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("GET /s/:participantToken/attachments/:attachment_id — happy paths", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the bytes when the attachment is referenced from an event in the pane", async () => {
    const { agentApiKey, paneId, participantToken } = await seedPane();
    const bytes = await makeJpeg(256);
    const { attachment_id, sha256, size } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "pane",
      paneId,
    );

    await agentEmitEvent(plainApp, agentApiKey, paneId, "image.attached", {
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
    // F-03: raster image → inline; F-06: framing defences on this path too.
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");

    const got = Buffer.from(await res.arrayBuffer());
    const gotSha = createHash("sha256").update(got).digest("hex");
    expect(gotSha).toBe(sha256);
  });

  it("returns the bytes when the attachment is referenced from pane inputData", async () => {
    // First upload an agent-scope attachment outside any pane, then create the
    // pane with inputData referencing it.
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

    // Now seed a pane that pins this attachment in inputData. We use the seed
    // helper directly because POST /v1/panes has its own access check;
    // seeding bypasses validation but we WANT a sane inputData here.
    const { paneId } = await seedPaneRow(prisma, {
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
        paneId,
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

  it("returns the bytes for an agent-scope attachment referenced from an event in the pane", async () => {
    // An agent-scope attachment (uploaded with no pane FK) referenced from an
    // event in this pane is reachable — the authz rule is "is this id
    // referenced from THIS pane?", not "does this attachment belong to this
    // pane's scope".
    const { agentApiKey, paneId, participantToken } = await seedPane();
    const bytes = await makeJpeg(256);
    const { attachment_id, sha256 } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "agent",
    );

    await agentEmitEvent(plainApp, agentApiKey, paneId, "image.attached", {
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
    const { participantToken, paneId } = await seedPane();
    await prisma.participant.updateMany({
      where: { paneId },
      data: { revokedAt: new Date() },
    });
    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, "aaaaaaaaaaaaaaaaaaaaa")),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("participant_token_invalid");
  });

  it("rejects downloads against a closed pane with 410 gone", async () => {
    const { participantToken, paneId } = await seedPane();
    await prisma.pane.update({
      where: { id: paneId },
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
// Authz — referenced-from-this-pane check
// ---------------------------------------------------------------------------

describe("GET /s/:participantToken/attachments/:attachment_id — authz", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects a token from pane A used to download a attachment only referenced in pane B with 404", async () => {
    // Pane A — has the attachment referenced.
    const a = await seedPane();
    const bytes = await makeJpeg(256);
    const { attachment_id } = await agentUploadBlob(
      plainApp,
      a.agentApiKey,
      bytes,
      "pane",
      a.paneId,
    );
    await agentEmitEvent(plainApp, a.agentApiKey, a.paneId, "image.attached", {
      attachment: { attachment_id, mime: "image/jpeg" },
    });

    // Pane B — same agent, different pane, never references the attachment.
    const { paneId: sessionBId } = await seedPaneRow(prisma, {
      agentId: a.agentId,
      eventSchema: blobEventSchema,
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const tokenB = generateHumanParticipantToken();
    await prisma.participant.create({
      data: {
        paneId: sessionBId,
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

  it("rejects a attachment_id of correct shape but not referenced in this pane with 404", async () => {
    // Seed a attachment the agent owns but the pane never references.
    const { agentApiKey, participantToken } = await seedPane();
    const bytes = await makeJpeg(256);
    const { attachment_id } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
    );
    // No event emitted, no inputData reference — the pane has no
    // pointer to this attachment.

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, attachment_id)),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_ref_not_accessible");
  });

  it("rejects a soft-deleted attachment with 404 even when previously referenced", async () => {
    const { agentApiKey, paneId, participantToken } = await seedPane();
    const bytes = await makeJpeg(256);
    const { attachment_id } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "pane",
      paneId,
    );
    await agentEmitEvent(plainApp, agentApiKey, paneId, "image.attached", {
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
    const { participantToken } = await seedPane();
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
    const { participantToken } = await seedPane();
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
// #505 (B) — record-referenced attachments resolve on download
// ---------------------------------------------------------------------------

describe("GET /s/:participantToken/attachments/:attachment_id — record refs (#505 B)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("serves an agent-owned attachment referenced ONLY from a record (no spurious 404)", async () => {
    const { agentApiKey, paneId, participantToken } =
      await seedPaneWithRecordSchema();
    const bytes = await makeJpeg(256);
    // Agent uploads (agent-scope) and references it from a RECORD only — never
    // from an event or inputData. Before the fix collectSessionBlobRefs never
    // walked records, so this download 404'd as attachment_ref_not_accessible.
    const { attachment_id, sha256 } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "agent",
    );
    await agentWriteRecord(plainApp, agentApiKey, paneId, "assets", {
      attachment_id,
    });

    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, attachment_id)),
    );
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(got).digest("hex")).toBe(sha256);
  });

  it("still 404s an attachment that is neither event-, input-, nor record-referenced", async () => {
    // Control: the record walk must not over-collect — an owned-but-unreferenced
    // attachment still fails closed.
    const { agentApiKey, participantToken } = await seedPaneWithRecordSchema();
    const bytes = await makeJpeg(256);
    const { attachment_id } = await agentUploadBlob(
      plainApp,
      agentApiKey,
      bytes,
      "agent",
    );
    // No record written referencing it.
    const res = await plainApp.fetch(
      new Request(getDownloadUrl(participantToken, attachment_id)),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_ref_not_accessible");
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
    const { paneId } = await seedPaneRow(prisma, {
      agentId: agent.id,
      eventSchema: blobEventSchema,
      status: "open",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const token = generateHumanParticipantToken();
    await prisma.participant.create({
      data: {
        paneId,
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
      "pane",
      paneId,
    );

    // Emit an event so the attachment is referenced by the pane.
    await agentEmitEvent(encryptedApp, apiKey, paneId, "image.attached", {
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
