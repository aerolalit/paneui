// End-to-end tests for the blob-reference DB access check (follow-up B
// of #156). Exercises both the event-POST path and the session-create
// path: each MUST reject a payload whose `format: pane-blob-id` site
// refers to a blob the calling agent cannot access.
//
// The walker itself has unit coverage in src/blobs/ref-access.test.ts;
// these tests verify the wiring + HTTP semantics (status code,
// error_code, error envelope shape).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { hashKey, keyPrefix } from "../../keys.js";
import { buildApp } from "../app.js";
import { makeBlobStore } from "../../blobs/index.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;
let blobDir: string;

// Schema declaring a blob ref inside an event payload — mirrors the
// example from Phase D of #156.
const blobEventSchema = {
  events: {
    "image.attach": {
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
      },
      emittedBy: ["page", "agent"],
    },
    // A "plain" event used by the regression test — no blob refs at all.
    "review.commentAdded": {
      payload: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
      },
      emittedBy: ["page", "agent"],
    },
  },
};

beforeAll(async () => {
  blobDir = mkdtempSync(join(tmpdir(), "ref-access-e2e-"));
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
    BLOB_MIME_ALLOWLIST: "image/jpeg,image/png",
  });
  const blobStore = await makeBlobStore(config);
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

function bearer(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { id: agent.id, apiKey };
}

/** Create a `ready` agent-scope blob owned by `ownerId`. Bypasses the
 *  upload route — we don't care about the bytes here, only the FK row. */
async function seedReadyBlob(
  ownerId: string,
  opts: { deleted?: boolean; sessionId?: string } = {},
): Promise<string> {
  const blob = await prisma.blob.create({
    data: {
      ownerId,
      scope: opts.sessionId ? "session" : "agent",
      sessionId: opts.sessionId ?? null,
      mime: "image/png",
      size: 1,
      sha256: randomBytes(32).toString("hex"),
      storageKey: `blob_${randomBytes(8).toString("hex")}`,
      status: "ready",
      ...(opts.deleted ? { status: "deleted", deletedAt: new Date() } : {}),
    },
  });
  return blob.id;
}

interface CreatedSession {
  sessionId: string;
  agentToken: string;
  humanToken: string;
}

async function createSessionWithBlobSchema(
  apiKey: string,
  body: Record<string, unknown> = {},
): Promise<CreatedSession> {
  const res = await app.fetch(
    new Request("http://t/v1/sessions", {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify({
        artifact: {
          type: "html-inline",
          source: "<html></html>",
          event_schema: blobEventSchema,
        },
        participants: { humans: 1 },
        ...body,
      }),
    }),
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as {
    session_id: string;
    tokens: { humans: string[]; agent: string };
  };
  return {
    sessionId: json.session_id,
    agentToken: json.tokens.agent,
    humanToken: json.tokens.humans[0]!,
  };
}

describe("blob-ref DB access check — events", () => {
  it("accepts an event referencing the agent's own blob", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const { sessionId, agentToken } = await createSessionWithBlobSchema(apiKey);
    const blobId = await seedReadyBlob(agentId);

    const res = await app.fetch(
      new Request(`http://t/v1/sessions/${sessionId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({
          type: "image.attach",
          data: { blob: { blob_id: blobId, mime: "image/png" } },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      event: { type: string; data: { blob: { blob_id: string } } };
    };
    expect(body.event.type).toBe("image.attach");
    expect(body.event.data.blob.blob_id).toBe(blobId);
  });

  it("rejects an event referencing another agent's blob with 422 blob_ref_not_accessible", async () => {
    const { id: aliceId } = await seedAgent();
    const { apiKey: bobKey } = await seedAgent();
    const aliceBlobId = await seedReadyBlob(aliceId);
    const { sessionId, agentToken } = await createSessionWithBlobSchema(bobKey);

    const res = await app.fetch(
      new Request(`http://t/v1/sessions/${sessionId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({
          type: "image.attach",
          data: { blob: { blob_id: aliceBlobId, mime: "image/png" } },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details: { inaccessible_ids: string[] };
      };
    };
    expect(body.error.code).toBe("blob_ref_not_accessible");
    expect(body.error.details.inaccessible_ids).toEqual([aliceBlobId]);
    expect(body.error.message).toContain(aliceBlobId);
  });

  it("rejects an event referencing a soft-deleted blob", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const blobId = await seedReadyBlob(agentId, { deleted: true });
    const { sessionId, agentToken } = await createSessionWithBlobSchema(apiKey);

    const res = await app.fetch(
      new Request(`http://t/v1/sessions/${sessionId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({
          type: "image.attach",
          data: { blob: { blob_id: blobId, mime: "image/png" } },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_ref_not_accessible");
  });

  it("rejects an event referencing a well-formed-but-nonexistent blob_id", async () => {
    const { apiKey } = await seedAgent();
    const { sessionId, agentToken } = await createSessionWithBlobSchema(apiKey);
    // cuid-shaped (passes Ajv format) but no Blob row exists.
    const ghostId = "cm00000000000000000000000z";

    const res = await app.fetch(
      new Request(`http://t/v1/sessions/${sessionId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({
          type: "image.attach",
          data: { blob: { blob_id: ghostId, mime: "image/png" } },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { inaccessible_ids: string[] } };
    };
    expect(body.error.code).toBe("blob_ref_not_accessible");
    expect(body.error.details.inaccessible_ids).toEqual([ghostId]);
  });

  it("regression: events with NO blob refs are unaffected (no DB lookup needed)", async () => {
    const { apiKey } = await seedAgent();
    const { sessionId, agentToken } = await createSessionWithBlobSchema(apiKey);

    const res = await app.fetch(
      new Request(`http://t/v1/sessions/${sessionId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({
          type: "review.commentAdded",
          data: { body: "no blobs here" },
        }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("a participant posting through their token is gated by the SESSION's agent, not the participant", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const blobId = await seedReadyBlob(agentId);
    const { sessionId, humanToken } = await createSessionWithBlobSchema(apiKey);

    // Human-side reference to the agent's blob — should be accepted, since
    // the session's owning agent owns the blob.
    const res = await app.fetch(
      new Request(`http://t/v1/sessions/${sessionId}/events`, {
        method: "POST",
        headers: bearer(humanToken),
        body: JSON.stringify({
          type: "image.attach",
          data: { blob: { blob_id: blobId, mime: "image/png" } },
        }),
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe("blob-ref DB access check — session create (input_data)", () => {
  // Helper: create a NAMED artifact + version with an input_schema declaring
  // a blob ref. The session-create path will then validate input_data
  // against this schema and run the ref-access check.
  async function seedArtifactWithBlobInputSchema(
    ownerId: string,
  ): Promise<string> {
    const artifact = await prisma.artifact.create({
      data: {
        ownerId,
        name: `art-${randomBytes(4).toString("hex")}`,
        slug: `slug-${randomBytes(4).toString("hex")}`,
        latestVersion: 1,
      },
    });
    await prisma.artifactVersion.create({
      data: {
        artifactId: artifact.id,
        version: 1,
        artifactType: "html-inline",
        artifactSource: "<html></html>",
        eventSchema: blobEventSchema,
        inputSchema: {
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
        },
      },
    });
    return artifact.id;
  }

  it("accepts initial state referencing the agent's own blob", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const artifactId = await seedArtifactWithBlobInputSchema(agentId);
    const blobId = await seedReadyBlob(agentId);

    const res = await app.fetch(
      new Request("http://t/v1/sessions", {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({
          artifact: { id: artifactId },
          participants: { humans: 1 },
          input_data: { cover: { blob_id: blobId } },
        }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("rejects initial state referencing another agent's blob with 422 blob_ref_not_accessible", async () => {
    const { id: aliceId } = await seedAgent();
    const { id: bobId, apiKey: bobKey } = await seedAgent();
    const artifactId = await seedArtifactWithBlobInputSchema(bobId);
    const aliceBlobId = await seedReadyBlob(aliceId);

    const res = await app.fetch(
      new Request("http://t/v1/sessions", {
        method: "POST",
        headers: bearer(bobKey),
        body: JSON.stringify({
          artifact: { id: artifactId },
          participants: { humans: 1 },
          input_data: { cover: { blob_id: aliceBlobId } },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { inaccessible_ids: string[] } };
    };
    expect(body.error.code).toBe("blob_ref_not_accessible");
    expect(body.error.details.inaccessible_ids).toEqual([aliceBlobId]);
  });
});
