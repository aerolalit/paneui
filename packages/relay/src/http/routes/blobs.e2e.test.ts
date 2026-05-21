// End-to-end tests for /v1/blobs (PR feat/blobs-foundation).
//
// Covers the foundation slice: agent-scope multipart uploads, agent-auth
// download, idempotent delete, MIME sniffing (sniff vs declared + sniff vs
// allowlist), size cap, cross-tenant isolation, scope-gate rejection of
// session + artifact scopes (which land in PR feat/blobs-scopes-tokens).
//
// Backed by a real FilesystemBlobStore over a tmpdir per test run.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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

const MAX_BLOB = 64 * 1024; // 64 KB for the size-cap test
const AGENT_CAP = 200 * 1024; // 200 KB per-agent aggregate (enough for several test blobs)

// Minimal valid JPEG: SOI (FFD8FF) header + payload bytes + EOI (FFD9).
// 64 bytes is enough to satisfy the sniff window plus the route's empty-file
// check; we never actually decode it.
function makeJpeg(size = 64): Buffer {
  const buf = Buffer.alloc(size);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  // Fill the middle with stable bytes so sha256s are reproducible if needed.
  for (let i = 4; i < size - 2; i++) buf[i] = i & 0xff;
  buf[size - 2] = 0xff;
  buf[size - 1] = 0xd9;
  return buf;
}

function makePng(size = 64): Buffer {
  // 8-byte PNG signature + filler.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const buf = Buffer.alloc(size);
  sig.copy(buf, 0);
  for (let i = 8; i < size; i++) buf[i] = i & 0xff;
  return buf;
}

beforeAll(async () => {
  blobDir = mkdtempSync(join(tmpdir(), "blob-e2e-"));

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
    // Keep MIME allowlist focused on what these tests upload.
    BLOB_MIME_ALLOWLIST: "image/jpeg,image/png,application/pdf",
  });
  const blobStore = await makeBlobStore(config);
  app = buildApp(config, prisma, undefined, blobStore);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
  rmSync(blobDir, { recursive: true, force: true });
});

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

interface UploadOpts {
  declaredMime?: string;
  filename?: string;
  scope?: string;
}

async function upload(
  apiKey: string,
  body: Buffer,
  opts: UploadOpts = {},
): Promise<Response> {
  const fd = new FormData();
  const blob = new Blob([new Uint8Array(body)], {
    type: opts.declaredMime ?? "image/jpeg",
  });
  fd.set("file", blob, opts.filename ?? "test.jpg");
  if (opts.scope) fd.set("scope", opts.scope);
  if (opts.filename) fd.set("filename", opts.filename);

  return app.fetch(
    new Request("http://t/v1/blobs", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: fd,
    }),
  );
}

async function getBlob(apiKey: string, blobId: string): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/blobs/${blobId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  );
}

async function deleteBlob(apiKey: string, blobId: string): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/blobs/${blobId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  );
}

describe("/v1/blobs — auth + scope gate", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects unauthenticated POST with 401", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/blobs", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects scope=session as 'not yet supported' (PR #2)", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, makeJpeg(), { scope: "session" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects scope=artifact as 'not yet supported' (PR #2)", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, makeJpeg(), { scope: "artifact" });
    expect(res.status).toBe(400);
  });
});

describe("/v1/blobs — POST happy path", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("uploads a JPEG, returns 201 with sniffed MIME + sha256 + size", async () => {
    const { apiKey } = await seedAgent();
    const body = makeJpeg(128);

    const res = await upload(apiKey, body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      blob_id: string;
      scope: string;
      mime: string;
      size: number;
      sha256: string;
      status: string;
      session_id: null;
      artifact_id: null;
    };
    expect(json.blob_id).toMatch(/^c[a-z0-9]+$/);
    expect(json.scope).toBe("agent");
    expect(json.mime).toBe("image/jpeg");
    expect(json.size).toBe(body.length);
    expect(json.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(json.status).toBe("ready");
    expect(json.session_id).toBeNull();
    expect(json.artifact_id).toBeNull();
  });

  it("accepts a PNG with a matching declared Content-Type", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, makePng(64), {
      declaredMime: "image/png",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { mime: string };
    expect(json.mime).toBe("image/png");
  });

  it("accepts when declared Content-Type is application/octet-stream", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, makeJpeg(), {
      declaredMime: "application/octet-stream",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { mime: string };
    expect(json.mime).toBe("image/jpeg"); // sniffed from bytes
  });

  it("stores the filename when provided", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, makeJpeg(), { filename: "vacation.jpg" });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { filename: string };
    expect(json.filename).toBe("vacation.jpg");
  });
});

describe("/v1/blobs — POST rejection paths", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("415 mime_mismatch when declared Content-Type lies about format", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, makeJpeg(), {
      declaredMime: "image/png", // bytes are JPEG, declared PNG
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as {
      error: { code: string; details: { declared: string; sniffed: string } };
    };
    expect(body.error.code).toBe("mime_mismatch");
    expect(body.error.details.declared).toBe("image/png");
    expect(body.error.details.sniffed).toBe("image/jpeg");
  });

  it("415 mime_disallowed for an HTML-looking payload", async () => {
    const { apiKey } = await seedAgent();
    // <!doctype html>... — sniffs as application/octet-stream, fails allowlist.
    const html = Buffer.from(
      "<!doctype html><html><body>hi</body></html>",
      "utf8",
    );
    const res = await upload(apiKey, html, {
      declaredMime: "application/octet-stream",
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("mime_disallowed");
  });

  it("400 invalid_request when the file part is missing", async () => {
    const { apiKey } = await seedAgent();
    const fd = new FormData();
    fd.set("scope", "agent");
    const res = await app.fetch(
      new Request("http://t/v1/blobs", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: fd,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("400 invalid_request when the uploaded file is empty", async () => {
    const { apiKey } = await seedAgent();
    const fd = new FormData();
    fd.set("file", new Blob([], { type: "image/jpeg" }), "empty.jpg");
    const res = await app.fetch(
      new Request("http://t/v1/blobs", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: fd,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("413 blob_size_exceeded when the upload exceeds MAX_BLOB_BYTES", async () => {
    const { apiKey } = await seedAgent();
    const big = makeJpeg(MAX_BLOB + 16);
    const res = await upload(apiKey, big);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_size_exceeded");
  });

  it("413 quota_exceeded when the per-agent aggregate is reached", async () => {
    const { apiKey } = await seedAgent();
    // Each upload is just under the per-blob cap; uploading enough of them
    // will push past the per-agent cap (AGENT_CAP = 200 KB, MAX_BLOB = 64 KB).
    const r1 = await upload(apiKey, makeJpeg(MAX_BLOB - 8));
    expect(r1.status).toBe(201);
    const r2 = await upload(apiKey, makeJpeg(MAX_BLOB - 8));
    expect(r2.status).toBe(201);
    const r3 = await upload(apiKey, makeJpeg(MAX_BLOB - 8));
    expect(r3.status).toBe(201);
    // Fourth would push past 4 * ~64 KB = ~256 KB > AGENT_CAP (200 KB).
    const r4 = await upload(apiKey, makeJpeg(MAX_BLOB - 8));
    expect(r4.status).toBe(413);
    const body = (await r4.json()) as {
      error: { code: string; details: { scope: string } };
    };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details.scope).toBe("agent");
  });
});

describe("/v1/blobs/:id — GET", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the uploaded bytes with hardened headers", async () => {
    const { apiKey } = await seedAgent();
    const payload = makeJpeg(96);
    const post = await upload(apiKey, payload);
    const { blob_id, sha256 } = (await post.json()) as {
      blob_id: string;
      sha256: string;
    };

    const get = await getBlob(apiKey, blob_id);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/jpeg");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-disposition")).toBe("inline");
    expect(get.headers.get("cache-control")).toBe("private, no-store");
    expect(get.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(get.headers.get("referrer-policy")).toBe("no-referrer");

    const buf = Buffer.from(await get.arrayBuffer());
    expect(buf.equals(payload)).toBe(true);

    // sha256 round-trips.
    const { createHash } = await import("node:crypto");
    const recomputed = createHash("sha256").update(buf).digest("hex");
    expect(recomputed).toBe(sha256);
  });

  it("attaches Content-Disposition: attachment for non-image MIME (PDF)", async () => {
    const { apiKey } = await seedAgent();
    const pdf = Buffer.alloc(64, 0);
    Buffer.from("%PDF-1.4\n").copy(pdf, 0);
    const res = await upload(apiKey, pdf, {
      declaredMime: "application/pdf",
      filename: "doc.pdf",
    });
    const { blob_id } = (await res.json()) as { blob_id: string };
    const get = await getBlob(apiKey, blob_id);
    expect(get.headers.get("content-disposition")).toBe("attachment");
  });

  it("returns blob_not_found for a foreign agent's blob (cross-tenant isolation)", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const post = await upload(alice.apiKey, makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };

    const get = await getBlob(bob.apiKey, blob_id);
    expect(get.status).toBe(404);
    const body = (await get.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_not_found");
  });

  it("returns blob_not_found for a bogus id", async () => {
    const { apiKey } = await seedAgent();
    const get = await getBlob(apiKey, "blob_does_not_exist");
    expect(get.status).toBe(404);
  });
});

describe("/v1/blobs/:id — DELETE", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("deletes a blob and returns { deleted: true }", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };

    const del = await deleteBlob(apiKey, blob_id);
    expect(del.status).toBe(200);
    const body = (await del.json()) as { blob_id: string; deleted: boolean };
    expect(body).toEqual({ blob_id, deleted: true });

    // Subsequent GET → blob_not_found.
    const get = await getBlob(apiKey, blob_id);
    expect(get.status).toBe(404);

    // Storage backend should have removed the file too.
    expect(existsSync(join(blobDir, `blob_${blob_id}`))).toBe(false);
  });

  it("is idempotent — second delete returns the same shape", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };

    const first = await deleteBlob(apiKey, blob_id);
    expect(first.status).toBe(200);
    const second = await deleteBlob(apiKey, blob_id);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { blob_id: string; deleted: boolean };
    expect(body).toEqual({ blob_id, deleted: true });
  });

  it("returns blob_not_found for a foreign agent's blob", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const post = await upload(alice.apiKey, makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };

    const del = await deleteBlob(bob.apiKey, blob_id);
    expect(del.status).toBe(404);
    // Alice's blob should still be readable.
    const alicesGet = await getBlob(alice.apiKey, blob_id);
    expect(alicesGet.status).toBe(200);
  });
});
