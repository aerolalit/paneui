// End-to-end test for `POST /s/:participantToken/attachments` — follow-up C of #156.
//
// Mirrors the pane tests in src/http/routes/attachments.e2e.test.ts so the human-
// side upload route can't drift from the agent-side route on security-
// sensitive behaviour (MIME sniff, polyglot defense, quotas). Uses a real
// FilesystemBlobStore over a tmpdir + a real Hono app.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

const MAX_BLOB = 200 * 1024;
const AGENT_CAP = 300 * 1024;

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;
let blobDir: string;

const minimalSchema = {
  events: {
    "photo.attached": {
      payload: {
        type: "object",
        properties: { attachment: { type: "object" } },
        required: ["attachment"],
        additionalProperties: false,
      },
      emittedBy: ["page", "agent"],
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

async function makeBigJpeg(targetBytes: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { randomBytes: rnd } = await import("node:crypto");
  let d = Math.max(64, Math.round(Math.sqrt(targetBytes / 2)));
  for (let i = 0; i < 6; i++) {
    const noise = rnd(d * d * 3);
    const out = await sharp(noise, {
      raw: { width: d, height: d, channels: 3 },
    })
      .jpeg({ quality: 100 })
      .toBuffer();
    if (out.length > targetBytes) return out;
    d = Math.round(d * 1.6);
  }
  throw new Error(`makeBigJpeg: couldn't grow past ${targetBytes} bytes`);
}

beforeAll(async () => {
  blobDir = mkdtempSync(join(tmpdir(), "attachment-bridge-e2e-"));

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
    MAX_BLOB_BYTES: String(MAX_BLOB),
    MAX_BLOBS_PER_AGENT_BYTES: String(AGENT_CAP),
    BLOB_MIME_ALLOWLIST: "image/jpeg,image/png,application/pdf",
    // Eviction off so quota_exceeded is observable (mirrors the no-LRU
    // describe block in the agent-side e2e tests).
    BLOB_LRU_EVICTION: "false",
  });
  const blobStore = await makeBlobStore(config);
  app = buildApp(config, prisma, undefined, blobStore);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
  rmSync(blobDir, { recursive: true, force: true });
});

async function seedPane(): Promise<{
  token: string;
  agentId: string;
  paneId: string;
}> {
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
    eventSchema: minimalSchema,
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
  return { token, agentId: agent.id, paneId };
}

interface UploadOpts {
  declaredMime?: string;
  filename?: string;
  /** Extra form fields the route should IGNORE — used to verify forced pane scope. */
  extra?: Record<string, string>;
}

async function upload(
  token: string,
  body: Buffer,
  opts: UploadOpts = {},
): Promise<Response> {
  const fd = new FormData();
  const attachment = new Blob([new Uint8Array(body)], {
    type: opts.declaredMime ?? "image/jpeg",
  });
  fd.set("file", attachment, opts.filename ?? "human.jpg");
  if (opts.filename) fd.set("filename", opts.filename);
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) fd.set(k, v);
  }

  return app.fetch(
    new Request(`http://t/s/${token}/attachments`, {
      method: "POST",
      body: fd,
    }),
  );
}

describe("POST /s/:participantToken/attachments — happy path", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("uploads a JPEG and returns a AttachmentRef pinned to scope='pane'", async () => {
    const { token, agentId, paneId } = await seedPane();
    const payload = await makeJpeg(128);

    const res = await upload(token, payload);
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      attachment_id: string;
      scope: string;
      mime: string;
      size: number;
      sha256: string;
      pane_id: string | null;
      template_id: string | null;
      status: string;
    };
    expect(json.scope).toBe("pane");
    expect(json.mime).toBe("image/jpeg");
    expect(json.pane_id).toBe(paneId);
    expect(json.template_id).toBeNull();
    expect(json.status).toBe("ready");

    // The Blob row's `ownerId` is the AGENT that owns the pane, not the
    // participant — human uploads count against the agent's footprint.
    const row = await prisma.attachment.findUnique({
      where: { id: json.attachment_id },
    });
    expect(row).not.toBeNull();
    expect(row!.ownerId).toBe(agentId);
    expect(row!.scope).toBe("pane");
    expect(row!.paneId).toBe(paneId);
  });

  it("forces scope=pane even when the client tries to send scope=agent", async () => {
    const { token, paneId } = await seedPane();
    const res = await upload(token, await makeJpeg(), {
      extra: {
        scope: "agent",
        // Even with these set, the route ignores them.
        pane_id: "pan_someone_else",
        template_id: "art_someone_else",
      },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      scope: string;
      pane_id: string | null;
      template_id: string | null;
    };
    expect(json.scope).toBe("pane");
    expect(json.pane_id).toBe(paneId);
    expect(json.template_id).toBeNull();
  });

  it("stores the filename when provided", async () => {
    const { token } = await seedPane();
    const res = await upload(token, await makeJpeg(), {
      filename: "selfie.jpg",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { filename: string };
    expect(json.filename).toBe("selfie.jpg");
  });
});

describe("POST /s/:participantToken/attachments — auth / token validation", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects a malformed token with 401 participant_token_invalid", async () => {
    const res = await upload("not-a-real-token", await makeJpeg());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("participant_token_invalid");
  });

  it("rejects a well-formed but unknown token with 401", async () => {
    const bogus = generateHumanParticipantToken();
    const res = await upload(bogus, await makeJpeg());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("participant_token_invalid");
  });

  it("rejects a revoked participant with 401", async () => {
    const { token, paneId } = await seedPane();
    await prisma.participant.updateMany({
      where: { paneId },
      data: { revokedAt: new Date() },
    });
    const res = await upload(token, await makeJpeg());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("participant_token_invalid");
  });

  it("rejects uploads to a closed pane with 410 gone", async () => {
    const { token, paneId } = await seedPane();
    await prisma.pane.update({
      where: { id: paneId },
      data: { status: "closed" },
    });
    const res = await upload(token, await makeJpeg());
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("gone");
  });

  it("rejects uploads to an expired pane with 410 gone", async () => {
    const { token, paneId } = await seedPane();
    await prisma.pane.update({
      where: { id: paneId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await upload(token, await makeJpeg());
    expect(res.status).toBe(410);
  });
});

describe("POST /s/:participantToken/attachments — rejection paths", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("400 invalid_request when the file part is missing", async () => {
    const { token } = await seedPane();
    const fd = new FormData();
    fd.set("filename", "no-file.jpg");
    const res = await app.fetch(
      new Request(`http://t/s/${token}/attachments`, {
        method: "POST",
        body: fd,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("415 mime_disallowed for an HTML-looking payload (polyglot defense)", async () => {
    const { token } = await seedPane();
    // FF D8 FF prefix sniffs as image/jpeg but the rest is HTML — sharp's
    // decode-then-encode pass refuses it, mirroring the agent-side route.
    const fakeJpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("<html><body>lied about its type</body></html>", "utf8"),
    ]);
    const res = await upload(token, fakeJpeg, { declaredMime: "image/jpeg" });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("mime_disallowed");
  });

  it("413 attachment_size_exceeded when the upload exceeds MAX_BLOB_BYTES", async () => {
    const { token } = await seedPane();
    const big = await makeBigJpeg(MAX_BLOB + 1024);
    const res = await upload(token, big);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_size_exceeded");
  });

  it("413 quota_exceeded when the agent's aggregate quota is exhausted", async () => {
    const { token } = await seedPane();
    const perBlob = 80 * 1024;
    // First three fit (240 KB total), 4th would push past the 300 KB cap.
    expect((await upload(token, await makeBigJpeg(perBlob))).status).toBe(201);
    expect((await upload(token, await makeBigJpeg(perBlob))).status).toBe(201);
    expect((await upload(token, await makeBigJpeg(perBlob))).status).toBe(201);
    const r4 = await upload(token, await makeBigJpeg(perBlob));
    expect(r4.status).toBe(413);
    const body = (await r4.json()) as {
      error: { code: string; details: { scope: string } };
    };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details.scope).toBe("agent");
  });
});

describe("POST /s/:participantToken/attachments — polyglot defense", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("strips HTML appended after a JPEG (same defense as POST /v1/attachments)", async () => {
    const { token } = await seedPane();
    const realJpeg = await makeJpeg(256);
    const polyglot = Buffer.concat([
      realJpeg,
      Buffer.from(
        "<html><body><script>alert('xss')</script></body></html>",
        "utf8",
      ),
    ]);

    const res = await upload(token, polyglot);
    expect(res.status).toBe(201);
    const { sha256 } = (await res.json()) as { sha256: string };

    // The stored sha256 should NOT equal the uploaded polyglot's sha256
    // because the route's sharp pass re-encoded without the tail.
    const { createHash } = await import("node:crypto");
    const polyglotSha = createHash("sha256").update(polyglot).digest("hex");
    expect(sha256).not.toBe(polyglotSha);
  });
});
