// End-to-end tests for the attachment-reference DB access check (follow-up B
// of #156). Exercises both the event-POST path and the surface-create
// path: each MUST reject a payload whose `format: pane-attachment-id` site
// refers to a attachment the calling agent cannot access.
//
// The walker itself has unit coverage in src/attachments/ref-access.test.ts;
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
import { makeBlobStore } from "../../attachments/index.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;
let blobDir: string;

// Schema declaring a attachment ref inside an event payload — mirrors the
// example from Phase D of #156.
const blobEventSchema = {
  events: {
    "image.attach": {
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
      },
      emittedBy: ["page", "agent"],
    },
    // A "plain" event used by the regression test — no attachment refs at all.
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

/** Create a `ready` agent-scope attachment owned by `ownerId`. Bypasses the
 *  upload route — we don't care about the bytes here, only the FK row. */
async function seedReadyBlob(
  ownerId: string,
  opts: { deleted?: boolean; surfaceId?: string } = {},
): Promise<string> {
  const attachment = await prisma.attachment.create({
    data: {
      ownerId,
      scope: opts.surfaceId ? "surface" : "agent",
      surfaceId: opts.surfaceId ?? null,
      mime: "image/png",
      size: 1,
      sha256: randomBytes(32).toString("hex"),
      storageKey: `attachment_${randomBytes(8).toString("hex")}`,
      status: "ready",
      ...(opts.deleted ? { status: "deleted", deletedAt: new Date() } : {}),
    },
  });
  return attachment.id;
}

interface CreatedSession {
  surfaceId: string;
  agentToken: string;
  humanToken: string;
}

async function createSessionWithBlobSchema(
  apiKey: string,
  body: Record<string, unknown> = {},
): Promise<CreatedSession> {
  const res = await app.fetch(
    new Request("http://t/v1/surfaces", {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify({
        title: "attachment-ref-access test surface",
        template: {
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
    surface_id: string;
    tokens: { humans: string[]; agent: string };
  };
  return {
    surfaceId: json.surface_id,
    agentToken: json.tokens.agent,
    humanToken: json.tokens.humans[0]!,
  };
}

describe("attachment-ref DB access check — events", () => {
  it("accepts an event referencing the agent's own attachment", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const { surfaceId, agentToken } = await createSessionWithBlobSchema(apiKey);
    const attachmentId = await seedReadyBlob(agentId);

    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({
          type: "image.attach",
          data: {
            attachment: { attachment_id: attachmentId, mime: "image/png" },
          },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      event: { type: string; data: { attachment: { attachment_id: string } } };
    };
    expect(body.event.type).toBe("image.attach");
    expect(body.event.data.attachment.attachment_id).toBe(attachmentId);
  });

  it("rejects an event referencing another agent's attachment with 422 attachment_ref_not_accessible", async () => {
    const { id: aliceId } = await seedAgent();
    const { apiKey: bobKey } = await seedAgent();
    const aliceBlobId = await seedReadyBlob(aliceId);
    const { surfaceId, agentToken } = await createSessionWithBlobSchema(bobKey);

    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({
          type: "image.attach",
          data: {
            attachment: { attachment_id: aliceBlobId, mime: "image/png" },
          },
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
    expect(body.error.code).toBe("attachment_ref_not_accessible");
    expect(body.error.details.inaccessible_ids).toEqual([aliceBlobId]);
    expect(body.error.message).toContain(aliceBlobId);
  });

  it("rejects an event referencing a soft-deleted attachment", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const attachmentId = await seedReadyBlob(agentId, { deleted: true });
    const { surfaceId, agentToken } = await createSessionWithBlobSchema(apiKey);

    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({
          type: "image.attach",
          data: {
            attachment: { attachment_id: attachmentId, mime: "image/png" },
          },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_ref_not_accessible");
  });

  it("rejects an event referencing a well-formed-but-nonexistent attachment_id", async () => {
    const { apiKey } = await seedAgent();
    const { surfaceId, agentToken } = await createSessionWithBlobSchema(apiKey);
    // cuid-shaped (passes Ajv format) but no Blob row exists.
    const ghostId = "cm00000000000000000000000z";

    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({
          type: "image.attach",
          data: { attachment: { attachment_id: ghostId, mime: "image/png" } },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { inaccessible_ids: string[] } };
    };
    expect(body.error.code).toBe("attachment_ref_not_accessible");
    expect(body.error.details.inaccessible_ids).toEqual([ghostId]);
  });

  it("regression: events with NO attachment refs are unaffected (no DB lookup needed)", async () => {
    const { apiKey } = await seedAgent();
    const { surfaceId, agentToken } = await createSessionWithBlobSchema(apiKey);

    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({
          type: "review.commentAdded",
          data: { body: "no attachments here" },
        }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("a participant posting through their token is gated by the SESSION's agent, not the participant", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const attachmentId = await seedReadyBlob(agentId);
    const { surfaceId, humanToken } = await createSessionWithBlobSchema(apiKey);

    // Human-side reference to the agent's attachment — should be accepted, since
    // the surface's owning agent owns the attachment.
    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/events`, {
        method: "POST",
        headers: bearer(humanToken),
        body: JSON.stringify({
          type: "image.attach",
          data: {
            attachment: { attachment_id: attachmentId, mime: "image/png" },
          },
        }),
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe("attachment-ref DB access check — surface create (input_data)", () => {
  // Helper: create a NAMED template + version with an input_schema declaring
  // a attachment ref. The surface-create path will then validate input_data
  // against this schema and run the ref-access check.
  async function seedArtifactWithBlobInputSchema(
    ownerId: string,
  ): Promise<string> {
    const template = await prisma.template.create({
      data: {
        ownerId,
        name: `art-${randomBytes(4).toString("hex")}`,
        slug: `slug-${randomBytes(4).toString("hex")}`,
        latestVersion: 1,
      },
    });
    await prisma.templateVersion.create({
      data: {
        templateId: template.id,
        version: 1,
        templateType: "html-inline",
        templateSource: "<html></html>",
        eventSchema: blobEventSchema,
        inputSchema: {
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
        },
      },
    });
    return template.id;
  }

  it("accepts initial state referencing the agent's own attachment", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const templateId = await seedArtifactWithBlobInputSchema(agentId);
    const attachmentId = await seedReadyBlob(agentId);

    const res = await app.fetch(
      new Request("http://t/v1/surfaces", {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({
          template: { id: templateId },
          participants: { humans: 1 },
          input_data: { cover: { attachment_id: attachmentId } },
        }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("rejects initial state referencing another agent's attachment with 422 attachment_ref_not_accessible", async () => {
    const { id: aliceId } = await seedAgent();
    const { id: bobId, apiKey: bobKey } = await seedAgent();
    const templateId = await seedArtifactWithBlobInputSchema(bobId);
    const aliceBlobId = await seedReadyBlob(aliceId);

    const res = await app.fetch(
      new Request("http://t/v1/surfaces", {
        method: "POST",
        headers: bearer(bobKey),
        body: JSON.stringify({
          template: { id: templateId },
          participants: { humans: 1 },
          input_data: { cover: { attachment_id: aliceBlobId } },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { inaccessible_ids: string[] } };
    };
    expect(body.error.code).toBe("attachment_ref_not_accessible");
    expect(body.error.details.inaccessible_ids).toEqual([aliceBlobId]);
  });
});

// Same set of guarantees, but driven by an INLINE template's input_schema
// instead of a named one (#208 regression). Pre-fix the inline branch
// hardcoded inputSchema to null, so the ref-access walker had nothing to
// walk — agent X could put any attachment_id into input_data and the access check
// would never fire, AND the participant attachment-download bridge would refuse
// to serve the agent's OWN attachment because the same null-schema gap made it
// invisible to the read-side walker.
describe("attachment-ref DB access check — inline surface create with input_schema (#208)", () => {
  const inlineInputSchema = {
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

  it("accepts an inline surface referencing the agent's own attachment via input_data", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const attachmentId = await seedReadyBlob(agentId);

    const res = await app.fetch(
      new Request("http://t/v1/surfaces", {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify({
          template: {
            type: "html-inline",
            source: "<html></html>",
            event_schema: blobEventSchema,
            input_schema: inlineInputSchema,
          },
          participants: { humans: 1 },
          title: "Blob ref test",
          input_data: { cover: { attachment_id: attachmentId } },
        }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("rejects an inline surface referencing another agent's attachment (the gate fires the same way as for named templates)", async () => {
    const { id: aliceId } = await seedAgent();
    const { apiKey: bobKey } = await seedAgent();
    const aliceBlobId = await seedReadyBlob(aliceId);

    const res = await app.fetch(
      new Request("http://t/v1/surfaces", {
        method: "POST",
        headers: bearer(bobKey),
        body: JSON.stringify({
          template: {
            type: "html-inline",
            source: "<html></html>",
            event_schema: blobEventSchema,
            input_schema: inlineInputSchema,
          },
          participants: { humans: 1 },
          title: "Blob ref test",
          input_data: { cover: { attachment_id: aliceBlobId } },
        }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { inaccessible_ids: string[] } };
    };
    expect(body.error.code).toBe("attachment_ref_not_accessible");
    expect(body.error.details.inaccessible_ids).toEqual([aliceBlobId]);
  });
});
