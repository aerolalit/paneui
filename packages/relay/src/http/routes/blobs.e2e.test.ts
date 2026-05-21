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

// Picked so makeBigJpeg can reliably produce blobs UNDER MAX_BLOB (~50 KB
// each on average) and a small number of them exceed AGENT_CAP. The route
// caps real production at 5 MB / 500 MB; we use much smaller numbers here
// so the test runs in milliseconds, not seconds.
const MAX_BLOB = 200 * 1024; // 200 KB cap for the size-cap test
const AGENT_CAP = 300 * 1024; // 300 KB per-agent aggregate (~6 test blobs)

// Real images, built via sharp. Synthetic byte-sequences with only the
// magic-bytes prefix would pass MIME sniffing but fail sharp's decode in
// the normalisation pass — the route correctly rejects them as
// `mime_disallowed`. The polyglot tests pass real images with hostile
// tails appended; sharp's decode-encode round trip drops the tail.
//
// `targetBytes` is a SOFT target — sharp picks dimensions / quality that
// roughly hit it. Used by the size-cap test where the actual byte count
// matters; happy-path tests don't care about exact size.

async function makeJpeg(
  approxBytes = 256,
  opts: { dimension?: number } = {},
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const d = opts.dimension ?? Math.max(8, Math.round(Math.sqrt(approxBytes)));
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

async function makePng(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 50, g: 200, b: 100, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

/**
 * Build a JPEG of incompressible noise that GUARANTEES `bytes > targetBytes`
 * after sharp's encode + the route's normalisation pass. Random pixel data
 * makes JPEG quality:100 unable to compress, so the encoded output scales
 * with pixel count. Loops dimensions until past the target.
 */
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
  throw new Error(
    `makeBigJpeg: couldn't grow past ${targetBytes} bytes within 6 iterations`,
  );
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
  sessionId?: string;
  artifactId?: string;
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
  if (opts.sessionId) fd.set("session_id", opts.sessionId);
  if (opts.artifactId) fd.set("artifact_id", opts.artifactId);

  return app.fetch(
    new Request("http://t/v1/blobs", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: fd,
    }),
  );
}

/**
 * Seed a minimal open session owned by `agentId`. Uses inline anonymous
 * artifact + version because that's the cheapest way to satisfy the FK chain
 * (Session → ArtifactVersion → Artifact) without standing up the real flow.
 */
async function seedSessionFor(agentId: string): Promise<string> {
  const artifact = await prisma.artifact.create({
    data: { ownerId: agentId, latestVersion: 1 },
  });
  const version = await prisma.artifactVersion.create({
    data: {
      artifactId: artifact.id,
      version: 1,
      artifactType: "html-inline",
      artifactSource: "<html></html>",
    },
  });
  const session = await prisma.session.create({
    data: {
      id: "ses_" + randomBytes(8).toString("hex"),
      agentId,
      artifactVersionId: version.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return session.id;
}

/** Seed a minimal named artifact owned by `agentId`. */
async function seedArtifactFor(agentId: string): Promise<string> {
  const artifact = await prisma.artifact.create({
    data: {
      ownerId: agentId,
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
    },
  });
  return artifact.id;
}

async function mintToken(
  apiKey: string,
  blobId: string,
  body: { ttl_seconds?: number; once?: boolean } = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/blobs/${blobId}/tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function revokeToken(
  apiKey: string,
  blobId: string,
  tokenId: string,
): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/blobs/${blobId}/tokens/${tokenId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  );
}

async function fetchByToken(token: string): Promise<Response> {
  return app.fetch(new Request(`http://t/b/${token}`));
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

describe("/v1/blobs — auth + scope validation", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects unauthenticated POST with 401", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/blobs", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects scope=session without session_id", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, await makeJpeg(), { scope: "session" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects scope=artifact without artifact_id", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, await makeJpeg(), { scope: "artifact" });
    expect(res.status).toBe(400);
  });

  it("rejects unknown scope value", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, await makeJpeg(), { scope: "nonsense" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { supported: string[] } };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.details.supported).toEqual([
      "agent",
      "session",
      "artifact",
    ]);
  });

  it("rejects scope=session with a foreign session_id (blob_not_found, not 403)", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const aliceSes = await seedSessionFor(alice.id);
    const res = await upload(bob.apiKey, await makeJpeg(), {
      scope: "session",
      sessionId: aliceSes,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_not_found");
  });

  it("rejects scope=artifact with a foreign artifact_id", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const aliceArt = await seedArtifactFor(alice.id);
    const res = await upload(bob.apiKey, await makeJpeg(), {
      scope: "artifact",
      artifactId: aliceArt,
    });
    expect(res.status).toBe(404);
  });
});

describe("/v1/blobs — POST happy path", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("uploads a JPEG, returns 201 with sniffed MIME + sha256 + size", async () => {
    const { apiKey } = await seedAgent();
    const body = await makeJpeg(128);

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
    const res = await upload(apiKey, await makePng(), {
      declaredMime: "image/png",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { mime: string };
    expect(json.mime).toBe("image/png");
  });

  it("accepts when declared Content-Type is application/octet-stream", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, await makeJpeg(), {
      declaredMime: "application/octet-stream",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { mime: string };
    expect(json.mime).toBe("image/jpeg"); // sniffed from bytes
  });

  it("stores the filename when provided", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, await makeJpeg(), {
      filename: "vacation.jpg",
    });
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
    const res = await upload(apiKey, await makeJpeg(), {
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
    // makeBigJpeg uses incompressible noise so the encoded output reliably
    // exceeds MAX_BLOB. A normal `makeJpeg` of a solid colour would compress
    // to a tiny file regardless of the requested dimension.
    const big = await makeBigJpeg(MAX_BLOB + 1024);
    const res = await upload(apiKey, big);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_size_exceeded");
  });

  it("413 quota_exceeded when the per-agent aggregate is reached", async () => {
    const { apiKey } = await seedAgent();
    // Each upload is ~80 KB (well under MAX_BLOB=200 KB); 4 of them = ~320 KB,
    // which trips AGENT_CAP=300 KB on the 4th. makeBigJpeg uses incompressible
    // noise so the encoded bytes scale predictably — a solid-colour JPEG
    // would compress to a few KB regardless of dimension.
    const perBlob = 80 * 1024;
    const r1 = await upload(apiKey, await makeBigJpeg(perBlob));
    expect(r1.status).toBe(201);
    const r2 = await upload(apiKey, await makeBigJpeg(perBlob));
    expect(r2.status).toBe(201);
    const r3 = await upload(apiKey, await makeBigJpeg(perBlob));
    expect(r3.status).toBe(201);
    // Fourth pushes past 4 * ~80 KB = ~320 KB > AGENT_CAP (300 KB).
    const r4 = await upload(apiKey, await makeBigJpeg(perBlob));
    expect(r4.status).toBe(413);
    const body = (await r4.json()) as {
      error: { code: string; details: { scope: string } };
    };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details.scope).toBe("agent");
  });
});

describe("/v1/blobs — polyglot defense (end-to-end via sharp)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("strips HTML appended after a JPEG (the bathroom-sink class of polyglot)", async () => {
    const { apiKey } = await seedAgent();
    const realJpeg = await makeJpeg(256);
    const polyglot = Buffer.concat([
      realJpeg,
      Buffer.from(
        "<html><body><script>alert('xss')</script></body></html>",
        "utf8",
      ),
    ]);

    const post = await upload(apiKey, polyglot);
    expect(post.status).toBe(201);
    const { blob_id, sha256 } = (await post.json()) as {
      blob_id: string;
      sha256: string;
    };

    // The stored sha256 should differ from the uploaded polyglot's sha256
    // because normalisation re-encoded the image without the tail.
    const { createHash } = await import("node:crypto");
    const polyglotSha = createHash("sha256").update(polyglot).digest("hex");
    expect(sha256).not.toBe(polyglotSha);

    // Fetch and verify the stored bytes contain no HTML tail.
    const get = await getBlob(apiKey, blob_id);
    const buf = Buffer.from(await get.arrayBuffer());
    const text = buf.toString("latin1");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("</html>");
    expect(text).not.toContain("alert");
  });

  it("rejects bytes that are sniffed as image but don't actually decode", async () => {
    const { apiKey } = await seedAgent();
    // FF D8 FF prefix sniffs as image/jpeg, but the rest is HTML — sharp
    // throws during normalisation, route returns mime_disallowed.
    const fakeJpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from(
        "<!doctype html><html><body>just html that lied about its format</body></html>",
        "utf8",
      ),
    ]);
    const res = await upload(apiKey, fakeJpeg, { declaredMime: "image/jpeg" });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("mime_disallowed");
  });

  it("strips EXIF from JPEGs containing a GPS tag", async () => {
    const { apiKey } = await seedAgent();
    const sharp = (await import("sharp")).default;
    const withGps = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 50, g: 100, b: 200 },
      },
    })
      .withExif({
        GPS: {
          GPSLatitudeRef: "N",
          GPSLatitude: "37/1,46/1,30/1",
        },
        IFD0: { Artist: "should-be-stripped" },
      })
      .jpeg()
      .toBuffer();

    // Sanity: input has EXIF.
    expect((await sharp(withGps).metadata()).exif).toBeDefined();

    const post = await upload(apiKey, withGps);
    expect(post.status).toBe(201);
    const { blob_id } = (await post.json()) as { blob_id: string };

    const get = await getBlob(apiKey, blob_id);
    const buf = Buffer.from(await get.arrayBuffer());
    // After the strip, the served bytes have no EXIF.
    expect((await sharp(buf).metadata()).exif).toBeUndefined();
  });
});

describe("/v1/blobs/:id — GET", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the uploaded bytes with hardened headers", async () => {
    const { apiKey } = await seedAgent();
    const payload = await makeJpeg(96);
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
    const post = await upload(alice.apiKey, await makeJpeg());
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
    const post = await upload(apiKey, await makeJpeg());
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
    const post = await upload(apiKey, await makeJpeg());
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
    const post = await upload(alice.apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };

    const del = await deleteBlob(bob.apiKey, blob_id);
    expect(del.status).toBe(404);
    // Alice's blob should still be readable.
    const alicesGet = await getBlob(alice.apiKey, blob_id);
    expect(alicesGet.status).toBe(200);
  });
});

// ===========================================================================
// Session + artifact scope uploads.
// ===========================================================================

describe("/v1/blobs — session-scope upload", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("uploads with scope=session and records sessionId", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const sessionId = await seedSessionFor(agentId);
    const res = await upload(apiKey, await makeJpeg(), {
      scope: "session",
      sessionId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      scope: string;
      session_id: string | null;
      artifact_id: string | null;
    };
    expect(body.scope).toBe("session");
    expect(body.session_id).toBe(sessionId);
    expect(body.artifact_id).toBeNull();
  });

  it("cascades on session delete (DB row goes away)", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const sessionId = await seedSessionFor(agentId);
    const post = await upload(apiKey, await makeJpeg(), {
      scope: "session",
      sessionId,
    });
    const { blob_id } = (await post.json()) as { blob_id: string };

    await prisma.session.delete({ where: { id: sessionId } });
    const found = await prisma.blob.findUnique({ where: { id: blob_id } });
    expect(found).toBeNull();
  });
});

describe("/v1/blobs — artifact-scope upload", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("uploads with scope=artifact and records artifactId", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const artifactId = await seedArtifactFor(agentId);
    const res = await upload(apiKey, await makeJpeg(), {
      scope: "artifact",
      artifactId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      scope: string;
      artifact_id: string | null;
      session_id: string | null;
    };
    expect(body.scope).toBe("artifact");
    expect(body.artifact_id).toBe(artifactId);
    expect(body.session_id).toBeNull();
  });

  it("cascades on artifact delete", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const artifactId = await seedArtifactFor(agentId);
    const post = await upload(apiKey, await makeJpeg(), {
      scope: "artifact",
      artifactId,
    });
    const { blob_id } = (await post.json()) as { blob_id: string };

    // ArtifactVersion has a cascade FK to Artifact; delete the version
    // first to avoid the same-PR test colliding with the FK check, then
    // the parent.
    await prisma.artifactVersion.deleteMany({ where: { artifactId } });
    await prisma.artifact.delete({ where: { id: artifactId } });
    const found = await prisma.blob.findUnique({ where: { id: blob_id } });
    expect(found).toBeNull();
  });
});

// ===========================================================================
// Token mint + revoke + /b/<token> capability URL.
// ===========================================================================

describe("/v1/blobs/:id/tokens — mint + revoke", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("mints a token; returns full token once + the hashed prefix + url + expiry", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };

    const mint = await mintToken(apiKey, blob_id);
    expect(mint.status).toBe(201);
    const body = (await mint.json()) as {
      token_id: string;
      token: string;
      token_prefix: string;
      url: string;
      expires_at: string;
      once: boolean;
    };
    expect(body.token).toMatch(/^paneb_[A-Za-z0-9_-]{32}$/);
    expect(body.token_prefix).toBe(body.token.slice(0, 10));
    expect(body.url.endsWith(`/b/${body.token}`)).toBe(true);
    expect(body.once).toBe(false);
    // Default agent-scope TTL = 24h; new Date(expires_at) should be in the
    // future and within a sensible window of that.
    const expires = new Date(body.expires_at).getTime();
    const now = Date.now();
    expect(expires).toBeGreaterThan(now);
    expect(expires).toBeLessThanOrEqual(now + 25 * 60 * 60 * 1000);
  });

  it("mints a token with once=true and a shorter TTL when requested", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };

    const mint = await mintToken(apiKey, blob_id, {
      ttl_seconds: 60,
      once: true,
    });
    const body = (await mint.json()) as {
      once: boolean;
      expires_at: string;
    };
    expect(body.once).toBe(true);
    const ttlMs = new Date(body.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(60 * 1000 + 1000); // small slack
    expect(ttlMs).toBeGreaterThan(0);
  });

  it("caps requested TTL at the scope default (caller can shorten, not lengthen)", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };

    // Request 365 days — should be clamped to the agent-scope default (24h).
    const mint = await mintToken(apiKey, blob_id, {
      ttl_seconds: 365 * 24 * 60 * 60,
    });
    const body = (await mint.json()) as { expires_at: string };
    const ttlMs = new Date(body.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });

  it("rejects mint for a foreign agent's blob", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const post = await upload(alice.apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };

    const mint = await mintToken(bob.apiKey, blob_id);
    expect(mint.status).toBe(404);
  });

  it("revokes a token (200 + idempotent on retry)", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };
    const mint = await mintToken(apiKey, blob_id);
    const { token_id } = (await mint.json()) as { token_id: string };

    const r1 = await revokeToken(apiKey, blob_id, token_id);
    expect(r1.status).toBe(200);
    const r2 = await revokeToken(apiKey, blob_id, token_id);
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { token_id: string; revoked: boolean };
    expect(body).toEqual({ token_id, revoked: true });
  });

  it("rejects revoke from a foreign agent (blob_not_found, no row leak)", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const post = await upload(alice.apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };
    const mint = await mintToken(alice.apiKey, blob_id);
    const { token_id } = (await mint.json()) as { token_id: string };

    const res = await revokeToken(bob.apiKey, blob_id, token_id);
    expect(res.status).toBe(404);
  });

  it("returns blob_token_not_found for a tokenId that belongs to a different blob", async () => {
    const { apiKey } = await seedAgent();
    const p1 = await upload(apiKey, await makeJpeg());
    const p2 = await upload(apiKey, await makeJpeg());
    const { blob_id: b1 } = (await p1.json()) as { blob_id: string };
    const { blob_id: b2 } = (await p2.json()) as { blob_id: string };
    const mint = await mintToken(apiKey, b1);
    const { token_id } = (await mint.json()) as { token_id: string };

    // tokenId belongs to b1, not b2.
    const res = await revokeToken(apiKey, b2, token_id);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_token_not_found");
  });
});

describe("/b/<token> — capability URL", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("fetches the bytes with hardened headers (no API key)", async () => {
    const { apiKey } = await seedAgent();
    const payload = await makeJpeg(128);
    const post = await upload(apiKey, payload);
    const { blob_id, sha256 } = (await post.json()) as {
      blob_id: string;
      sha256: string;
    };
    const mint = await mintToken(apiKey, blob_id);
    const { token } = (await mint.json()) as { token: string };

    const res = await fetchByToken(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(payload)).toBe(true);

    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(buf).digest("hex")).toBe(sha256);
  });

  it("attaches Content-Disposition: attachment for a PDF", async () => {
    const { apiKey } = await seedAgent();
    const pdf = Buffer.alloc(64, 0);
    Buffer.from("%PDF-1.4\n").copy(pdf, 0);
    const post = await upload(apiKey, pdf, {
      declaredMime: "application/pdf",
    });
    const { blob_id } = (await post.json()) as { blob_id: string };
    const mint = await mintToken(apiKey, blob_id);
    const { token } = (await mint.json()) as { token: string };

    const res = await fetchByToken(token);
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  it("rejects an unknown token with blob_token_invalid (no DB-existence leak)", async () => {
    const fake = "paneb_" + "A".repeat(32);
    const res = await fetchByToken(fake);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_token_invalid");
  });

  it("rejects a malformed token before the DB hit", async () => {
    const res = await fetchByToken("not-a-blob-token");
    expect(res.status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };
    const mint = await mintToken(apiKey, blob_id);
    const { token, token_id } = (await mint.json()) as {
      token: string;
      token_id: string;
    };
    await revokeToken(apiKey, blob_id, token_id);

    const res = await fetchByToken(token);
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };
    const mint = await mintToken(apiKey, blob_id);
    const { token, token_id } = (await mint.json()) as {
      token: string;
      token_id: string;
    };

    // Backdate the expiry into the past directly in the DB.
    await prisma.blobToken.update({
      where: { id: token_id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await fetchByToken(token);
    expect(res.status).toBe(401);
  });

  it("once-token: consumed on first GET, second GET fails", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };
    const mint = await mintToken(apiKey, blob_id, { once: true });
    const { token, token_id } = (await mint.json()) as {
      token: string;
      token_id: string;
    };

    const first = await fetchByToken(token);
    expect(first.status).toBe(200);
    // Drain the body so the audit-write fires (it runs via setImmediate
    // after the body is enqueued; we poll until the row is gone since the
    // delete + cache add are async).
    await first.arrayBuffer();
    await waitForTokenGone(token_id);

    // Second GET — invalid (cache + DB miss).
    const second = await fetchByToken(token);
    expect(second.status).toBe(401);
  });

  it("multi-use token: increments use_count + writes truncated IPs", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { blob_id } = (await post.json()) as { blob_id: string };
    const mint = await mintToken(apiKey, blob_id);
    const { token, token_id } = (await mint.json()) as {
      token: string;
      token_id: string;
    };

    // Fetch with a real X-Forwarded-For so the truncated IP gets written.
    const fetchWithIp = (ip: string) =>
      app.fetch(
        new Request(`http://t/b/${token}`, {
          headers: { "x-forwarded-for": ip },
        }),
      );

    const r1 = await fetchWithIp("203.0.113.42");
    expect(r1.status).toBe(200);
    await r1.arrayBuffer();
    await waitForUseCount(token_id, 1);

    const r2 = await fetchWithIp("198.51.100.7");
    expect(r2.status).toBe(200);
    await r2.arrayBuffer();
    await waitForUseCount(token_id, 2);

    const row = await prisma.blobToken.findUnique({
      where: { id: token_id },
    });
    expect(row).not.toBeNull();
    expect(row!.useCount).toBe(2);
    expect(row!.firstSeenIpNet).toBe("203.0.113.0/24");
    expect(row!.lastSeenIpNet).toBe("198.51.100.0/24");
    expect(row!.lastUsedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Polling helpers — the audit write fires in a setImmediate after the body
// is enqueued, so the test needs to wait for the DB to catch up. A fixed
// `setTimeout(50)` would be a flake source; polling caps at 1s and bails
// loudly if it never converges.
// ---------------------------------------------------------------------------
async function waitForUseCount(
  tokenId: string,
  expected: number,
  deadlineMs = 1000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const row = await prisma.blobToken.findUnique({ where: { id: tokenId } });
    if (row && row.useCount >= expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `BlobToken ${tokenId} did not reach useCount=${expected} within ${deadlineMs}ms`,
  );
}

async function waitForTokenGone(
  tokenId: string,
  deadlineMs = 1000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const row = await prisma.blobToken.findUnique({ where: { id: tokenId } });
    if (!row) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `BlobToken ${tokenId} still exists after ${deadlineMs}ms (once-consumption stuck)`,
  );
}
