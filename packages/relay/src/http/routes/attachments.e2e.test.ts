// End-to-end tests for /v1/attachments (PR feat/attachments-foundation).
//
// Covers the foundation slice: agent-scope multipart uploads, agent-auth
// download, idempotent delete, MIME sniffing (sniff vs declared + sniff vs
// allowlist), size cap, cross-tenant isolation, scope-gate rejection of
// pane + template scopes (which land in PR feat/attachments-scopes-tokens).
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
import { makeBlobStore } from "../../attachments/index.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;
let blobDir: string;

// Picked so makeBigJpeg can reliably produce attachments UNDER MAX_BLOB (~50 KB
// each on average) and a small number of them exceed AGENT_CAP. The route
// caps real production at 5 MB / 500 MB; we use much smaller numbers here
// so the test runs in milliseconds, not seconds.
const MAX_BLOB = 200 * 1024; // 200 KB cap for the size-cap test
const AGENT_CAP = 300 * 1024; // 300 KB per-agent aggregate (~6 test attachments)

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
  blobDir = mkdtempSync(join(tmpdir(), "attachment-e2e-"));

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
    // Disable the per-IP general rate limiter for this suite. All tests share
    // one IP (jsdom / vitest), so the prod default (120 req/min) is consumed
    // by the ~300+ HTTP calls this file makes — manifests as flaky 429s on
    // whichever tests happen to land near the end of the window. Tests don't
    // exercise the limiter itself; rate_limit.e2e.test.ts owns that pane.
    RATE_LIMIT: "0",
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
  paneId?: string;
  templateId?: string;
}

async function upload(
  apiKey: string,
  body: Buffer,
  opts: UploadOpts = {},
): Promise<Response> {
  const fd = new FormData();
  const attachment = new Blob([new Uint8Array(body)], {
    type: opts.declaredMime ?? "image/jpeg",
  });
  fd.set("file", attachment, opts.filename ?? "test.jpg");
  if (opts.scope) fd.set("scope", opts.scope);
  if (opts.filename) fd.set("filename", opts.filename);
  if (opts.paneId) fd.set("pane_id", opts.paneId);
  if (opts.templateId) fd.set("template_id", opts.templateId);

  return app.fetch(
    new Request("http://t/v1/attachments", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: fd,
    }),
  );
}

/**
 * Seed a minimal open pane owned by `agentId`. Uses inline anonymous
 * template + version because that's the cheapest way to satisfy the FK chain
 * (Pane → TemplateVersion → Template) without standing up the real flow.
 */
async function seedPaneFor(agentId: string): Promise<string> {
  const template = await prisma.template.create({
    data: { ownerId: agentId, name: "Attachments Test", latestVersion: 1 },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<html></html>",
    },
  });
  const pane = await prisma.pane.create({
    data: {
      id: "pan_" + randomBytes(8).toString("hex"),
      agentId,
      templateVersionId: version.id,
      title: "attachments e2e test pane",
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return pane.id;
}

/** Seed a minimal named template owned by `agentId`. */
async function seedArtifactFor(agentId: string): Promise<string> {
  const template = await prisma.template.create({
    data: {
      ownerId: agentId,
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
    },
  });
  return template.id;
}

async function mintToken(
  apiKey: string,
  attachmentId: string,
  body: { ttl_seconds?: number; once?: boolean } = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/attachments/${attachmentId}/tokens`, {
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
  attachmentId: string,
  tokenId: string,
): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/attachments/${attachmentId}/tokens/${tokenId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  );
}

async function fetchByToken(token: string): Promise<Response> {
  return app.fetch(new Request(`http://t/b/${token}`));
}

async function getBlob(
  apiKey: string,
  attachmentId: string,
): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/attachments/${attachmentId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  );
}

async function deleteBlob(
  apiKey: string,
  attachmentId: string,
): Promise<Response> {
  return app.fetch(
    new Request(`http://t/v1/attachments/${attachmentId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  );
}

describe("/v1/attachments — auth + scope validation", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("rejects unauthenticated POST with 401", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/attachments", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects scope=pane without pane_id", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, await makeJpeg(), { scope: "pane" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects scope=template without template_id", async () => {
    const { apiKey } = await seedAgent();
    const res = await upload(apiKey, await makeJpeg(), { scope: "template" });
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
    expect(body.error.details.supported).toEqual(["agent", "pane", "template"]);
  });

  it("rejects scope=pane with a foreign pane_id (attachment_not_found, not 403)", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const aliceSes = await seedPaneFor(alice.id);
    const res = await upload(bob.apiKey, await makeJpeg(), {
      scope: "pane",
      paneId: aliceSes,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_not_found");
  });

  it("rejects scope=template with a foreign template_id", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const aliceArt = await seedArtifactFor(alice.id);
    const res = await upload(bob.apiKey, await makeJpeg(), {
      scope: "template",
      templateId: aliceArt,
    });
    expect(res.status).toBe(404);
  });
});

describe("/v1/attachments — POST happy path", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("uploads a JPEG, returns 201 with sniffed MIME + sha256 + size", async () => {
    const { apiKey } = await seedAgent();
    const body = await makeJpeg(128);

    const res = await upload(apiKey, body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      attachment_id: string;
      scope: string;
      mime: string;
      size: number;
      sha256: string;
      status: string;
      pane_id: null;
      template_id: null;
    };
    expect(json.attachment_id).toMatch(/^c[a-z0-9]+$/);
    expect(json.scope).toBe("agent");
    expect(json.mime).toBe("image/jpeg");
    expect(json.size).toBe(body.length);
    expect(json.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(json.status).toBe("ready");
    expect(json.pane_id).toBeNull();
    expect(json.template_id).toBeNull();
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

describe("/v1/attachments — POST rejection paths", () => {
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

  it("415 mime_disallowed for an SVG under the restricted allowlist", async () => {
    const { apiKey } = await seedAgent();
    // An SVG carrying an inline script — the stored-XSS payload F-03 is about.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>',
      "utf8",
    );
    const res = await upload(apiKey, svg, {
      declaredMime: "image/svg+xml",
      filename: "x.svg",
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
      new Request("http://t/v1/attachments", {
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
      new Request("http://t/v1/attachments", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: fd,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("413 attachment_size_exceeded when the upload exceeds MAX_BLOB_BYTES", async () => {
    const { apiKey } = await seedAgent();
    // makeBigJpeg uses incompressible noise so the encoded output reliably
    // exceeds MAX_BLOB. A normal `makeJpeg` of a solid colour would compress
    // to a tiny file regardless of the requested dimension.
    const big = await makeBigJpeg(MAX_BLOB + 1024);
    const res = await upload(apiKey, big);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_size_exceeded");
  });

  // The quota_exceeded REJECTION path is exercised by the dedicated
  // describe block below (a separate app instance configured with
  // BLOB_LRU_EVICTION=false). The DEFAULT app has LRU eviction on, so
  // a 4th upload over the cap succeeds by evicting the oldest agent-
  // scope attachment — that case is covered by the LRU describe block further
  // down in this file.
});

describe("/v1/attachments — polyglot defense (end-to-end via sharp)", () => {
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
    const { attachment_id, sha256 } = (await post.json()) as {
      attachment_id: string;
      sha256: string;
    };

    // The stored sha256 should differ from the uploaded polyglot's sha256
    // because normalisation re-encoded the image without the tail.
    const { createHash } = await import("node:crypto");
    const polyglotSha = createHash("sha256").update(polyglot).digest("hex");
    expect(sha256).not.toBe(polyglotSha);

    // Fetch and verify the stored bytes contain no HTML tail.
    const get = await getBlob(apiKey, attachment_id);
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
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    const get = await getBlob(apiKey, attachment_id);
    const buf = Buffer.from(await get.arrayBuffer());
    // After the strip, the served bytes have no EXIF.
    expect((await sharp(buf).metadata()).exif).toBeUndefined();
  });
});

describe("/v1/attachments/:id — GET", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the uploaded bytes with hardened headers", async () => {
    const { apiKey } = await seedAgent();
    const payload = await makeJpeg(96);
    const post = await upload(apiKey, payload);
    const { attachment_id, sha256 } = (await post.json()) as {
      attachment_id: string;
      sha256: string;
    };

    const get = await getBlob(apiKey, attachment_id);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/jpeg");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-disposition")).toBe("inline");
    expect(get.headers.get("cache-control")).toBe("private, no-store");
    expect(get.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(get.headers.get("referrer-policy")).toBe("no-referrer");
    // F-06: framing defences on the agent download path too.
    expect(get.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    expect(get.headers.get("x-frame-options")).toBe("DENY");

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
    const { attachment_id } = (await res.json()) as { attachment_id: string };
    const get = await getBlob(apiKey, attachment_id);
    expect(get.headers.get("content-disposition")).toBe("attachment");
  });

  it("returns attachment_not_found for a foreign agent's attachment (cross-tenant isolation)", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const post = await upload(alice.apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    const get = await getBlob(bob.apiKey, attachment_id);
    expect(get.status).toBe(404);
    const body = (await get.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_not_found");
  });

  it("returns attachment_not_found for a bogus id", async () => {
    const { apiKey } = await seedAgent();
    const get = await getBlob(apiKey, "attachment_does_not_exist");
    expect(get.status).toBe(404);
  });
});

describe("/v1/attachments/:id/metadata — GET", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the full AttachmentRef JSON without streaming bytes", async () => {
    const { apiKey } = await seedAgent();
    const payload = await makeJpeg(96);
    const post = await upload(apiKey, payload, { filename: "hello.jpg" });
    const postBody = (await post.json()) as Record<string, unknown>;
    const attachmentId = postBody.attachment_id as string;

    const res = await app.fetch(
      new Request(`http://t/v1/attachments/${attachmentId}/metadata`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as Record<string, unknown>;
    // The metadata endpoint MUST return the exact same shape POST /v1/attachments
    // returns — that's the contract the CLI / core client rely on.
    expect(body).toEqual(postBody);
    expect(body.attachment_id).toBe(attachmentId);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.filename).toBe("hello.jpg");
    expect(body.scope).toBe("agent");
    expect(body.mime).toBe("image/jpeg");
    expect(body.size).toBe(payload.length);
    expect(body.status).toBe("ready");
  });

  it("returns attachment_not_found for a foreign agent's attachment (cross-tenant isolation)", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const post = await upload(alice.apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    const res = await app.fetch(
      new Request(`http://t/v1/attachments/${attachment_id}/metadata`, {
        headers: { authorization: `Bearer ${bob.apiKey}` },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_not_found");
  });

  it("returns attachment_not_found for a deleted attachment", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };
    await deleteBlob(apiKey, attachment_id);

    const res = await app.fetch(
      new Request(`http://t/v1/attachments/${attachment_id}/metadata`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("requires authentication (401 without bearer)", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };
    const res = await app.fetch(
      new Request(`http://t/v1/attachments/${attachment_id}/metadata`),
    );
    expect(res.status).toBe(401);
  });
});

describe("/v1/attachments/:id — DELETE", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("deletes a attachment and returns { deleted: true }", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    const del = await deleteBlob(apiKey, attachment_id);
    expect(del.status).toBe(200);
    const body = (await del.json()) as {
      attachment_id: string;
      deleted: boolean;
    };
    expect(body).toEqual({ attachment_id, deleted: true });

    // Subsequent GET → attachment_not_found.
    const get = await getBlob(apiKey, attachment_id);
    expect(get.status).toBe(404);

    // Storage backend should have removed the file too.
    expect(existsSync(join(blobDir, `attachment_${attachment_id}`))).toBe(
      false,
    );
  });

  it("is idempotent — second delete returns the same shape", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    const first = await deleteBlob(apiKey, attachment_id);
    expect(first.status).toBe(200);
    const second = await deleteBlob(apiKey, attachment_id);
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      attachment_id: string;
      deleted: boolean;
    };
    expect(body).toEqual({ attachment_id, deleted: true });
  });

  it("returns attachment_not_found for a foreign agent's attachment", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const post = await upload(alice.apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    const del = await deleteBlob(bob.apiKey, attachment_id);
    expect(del.status).toBe(404);
    // Alice's attachment should still be readable.
    const alicesGet = await getBlob(alice.apiKey, attachment_id);
    expect(alicesGet.status).toBe(200);
  });
});

// ===========================================================================
// Pane + template scope uploads.
// ===========================================================================

describe("/v1/attachments — pane-scope upload", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("uploads with scope=pane and records paneId", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const paneId = await seedPaneFor(agentId);
    const res = await upload(apiKey, await makeJpeg(), {
      scope: "pane",
      paneId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      scope: string;
      pane_id: string | null;
      template_id: string | null;
    };
    expect(body.scope).toBe("pane");
    expect(body.pane_id).toBe(paneId);
    expect(body.template_id).toBeNull();
  });

  it("cascades on pane delete (DB row goes away)", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const paneId = await seedPaneFor(agentId);
    const post = await upload(apiKey, await makeJpeg(), {
      scope: "pane",
      paneId,
    });
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    await prisma.pane.delete({ where: { id: paneId } });
    const found = await prisma.attachment.findUnique({
      where: { id: attachment_id },
    });
    expect(found).toBeNull();
  });

  // Regression for issue #209. The DB-level cascade above only fires on a real
  // row delete; the HTTP DELETE /v1/panes/:id route does a soft close
  // (status="closed", expiresAt=now()) and the cascade never runs in practice.
  // Without the explicit cascade in the route, the attachment row stayed
  // status="ready" / deletedAt=null indefinitely — quota leak, /b/<token>
  // links kept working, scope contract broken.
  it("soft-deletes pane-scope attachments via the HTTP pane delete route", async () => {
    const { apiKey } = await seedAgent();

    // Use the real create flow so the pane is created end-to-end.
    const create = await app.fetch(
      new Request("http://t/v1/panes", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          template: {
            name: "soft-deletes pane-scope attachments via the HTTP pane delete",
            type: "html-inline",
            source: "<html></html>",
            event_schema: {
              events: {
                ping: {
                  emittedBy: ["agent"],
                  payload: { type: "object", additionalProperties: true },
                },
              },
            },
          },
          title: "issue-209 regression",
        }),
      }),
    );
    expect(create.status).toBe(201);
    const { pane_id } = (await create.json()) as { pane_id: string };

    const upRes = await upload(apiKey, await makeJpeg(), {
      scope: "pane",
      paneId: pane_id,
    });
    expect(upRes.status).toBe(201);
    const { attachment_id } = (await upRes.json()) as { attachment_id: string };

    const del = await app.fetch(
      new Request(`http://t/v1/panes/${pane_id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(del.status).toBe(204);

    // Row is still there (soft-delete), but marked deleted.
    const row = await prisma.attachment.findUnique({
      where: { id: attachment_id },
    });
    expect(row).not.toBeNull();
    expect(row?.status).toBe("deleted");
    expect(row?.deletedAt).not.toBeNull();

    // Agent-side GET now returns attachment_not_found, same as for any soft-deleted
    // attachment (the existing /v1/attachments/:id GET handler folds status="deleted" into
    // the not-found pane — defense in depth + existence-oracle parity).
    const getAfter = await app.fetch(
      new Request(`http://t/v1/attachments/${attachment_id}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(getAfter.status).toBe(404);

    // List no longer panes it — quota accounting drops accordingly.
    const list = await app.fetch(
      new Request("http://t/v1/attachments", {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    const listBody = (await list.json()) as {
      items: Array<{ attachment_id: string }>;
    };
    expect(
      listBody.items.find((i) => i.attachment_id === attachment_id),
    ).toBeUndefined();
  });

  it("pane delete is a no-op for already-soft-deleted attachments (idempotent)", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const paneId = await seedPaneFor(agentId);

    const upRes = await upload(apiKey, await makeJpeg(), {
      scope: "pane",
      paneId,
    });
    const { attachment_id } = (await upRes.json()) as { attachment_id: string };

    // Pre-delete the attachment via the per-attachment API, then close the pane. The
    // pane-delete path must not try to re-delete the storage object or
    // double-flip the row.
    const delBlob = await app.fetch(
      new Request(`http://t/v1/attachments/${attachment_id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(delBlob.status).toBe(200);

    const delPane = await app.fetch(
      new Request(`http://t/v1/panes/${paneId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(delPane.status).toBe(204);

    const row = await prisma.attachment.findUnique({
      where: { id: attachment_id },
    });
    expect(row?.status).toBe("deleted");
  });
});

describe("/v1/attachments — template-scope upload", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("uploads with scope=template and records templateId", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const templateId = await seedArtifactFor(agentId);
    const res = await upload(apiKey, await makeJpeg(), {
      scope: "template",
      templateId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      scope: string;
      template_id: string | null;
      pane_id: string | null;
    };
    expect(body.scope).toBe("template");
    expect(body.template_id).toBe(templateId);
    expect(body.pane_id).toBeNull();
  });

  it("cascades on template delete", async () => {
    const { id: agentId, apiKey } = await seedAgent();
    const templateId = await seedArtifactFor(agentId);
    const post = await upload(apiKey, await makeJpeg(), {
      scope: "template",
      templateId,
    });
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    // TemplateVersion has a cascade FK to Template; delete the version
    // first to avoid the same-PR test colliding with the FK check, then
    // the parent.
    await prisma.templateVersion.deleteMany({ where: { templateId } });
    await prisma.template.delete({ where: { id: templateId } });
    const found = await prisma.attachment.findUnique({
      where: { id: attachment_id },
    });
    expect(found).toBeNull();
  });
});

// ===========================================================================
// Token mint + revoke + /b/<token> capability URL.
// ===========================================================================

describe("/v1/attachments/:id/tokens — mint + revoke", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("mints a token; returns full token once + the hashed prefix + url + expiry", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    const mint = await mintToken(apiKey, attachment_id);
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
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    const mint = await mintToken(apiKey, attachment_id, {
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
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    // Request 365 days — should be clamped to the agent-scope default (24h).
    const mint = await mintToken(apiKey, attachment_id, {
      ttl_seconds: 365 * 24 * 60 * 60,
    });
    const body = (await mint.json()) as { expires_at: string };
    const ttlMs = new Date(body.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });

  it("rejects mint for a foreign agent's attachment", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const post = await upload(alice.apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    const mint = await mintToken(bob.apiKey, attachment_id);
    expect(mint.status).toBe(404);
  });

  it("revokes a token (200 + idempotent on retry)", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };
    const mint = await mintToken(apiKey, attachment_id);
    const { token_id } = (await mint.json()) as { token_id: string };

    const r1 = await revokeToken(apiKey, attachment_id, token_id);
    expect(r1.status).toBe(200);
    const r2 = await revokeToken(apiKey, attachment_id, token_id);
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { token_id: string; revoked: boolean };
    expect(body).toEqual({ token_id, revoked: true });
  });

  it("rejects revoke from a foreign agent (attachment_not_found, no row leak)", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const post = await upload(alice.apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };
    const mint = await mintToken(alice.apiKey, attachment_id);
    const { token_id } = (await mint.json()) as { token_id: string };

    const res = await revokeToken(bob.apiKey, attachment_id, token_id);
    expect(res.status).toBe(404);
  });

  it("returns attachment_token_not_found for a tokenId that belongs to a different attachment", async () => {
    const { apiKey } = await seedAgent();
    const p1 = await upload(apiKey, await makeJpeg());
    const p2 = await upload(apiKey, await makeJpeg());
    const { attachment_id: b1 } = (await p1.json()) as {
      attachment_id: string;
    };
    const { attachment_id: b2 } = (await p2.json()) as {
      attachment_id: string;
    };
    const mint = await mintToken(apiKey, b1);
    const { token_id } = (await mint.json()) as { token_id: string };

    // tokenId belongs to b1, not b2.
    const res = await revokeToken(apiKey, b2, token_id);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_token_not_found");
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
    const { attachment_id, sha256 } = (await post.json()) as {
      attachment_id: string;
      sha256: string;
    };
    const mint = await mintToken(apiKey, attachment_id);
    const { token } = (await mint.json()) as { token: string };

    const res = await fetchByToken(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // #202: anti-framing. CORP=same-origin only blocks cross-origin
    // embedders from READING the bytes; a same-site page can still
    // frame an inline image. CSP frame-ancestors + X-Frame-Options
    // close that gap.
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");

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
    const { attachment_id } = (await post.json()) as { attachment_id: string };
    const mint = await mintToken(apiKey, attachment_id);
    const { token } = (await mint.json()) as { token: string };

    const res = await fetchByToken(token);
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  it("rejects an unknown token with attachment_token_invalid (no DB-existence leak)", async () => {
    const fake = "paneb_" + "A".repeat(32);
    const res = await fetchByToken(fake);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_token_invalid");
  });

  it("rejects a malformed token before the DB hit", async () => {
    const res = await fetchByToken("not-a-attachment-token");
    expect(res.status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };
    const mint = await mintToken(apiKey, attachment_id);
    const { token, token_id } = (await mint.json()) as {
      token: string;
      token_id: string;
    };
    await revokeToken(apiKey, attachment_id, token_id);

    const res = await fetchByToken(token);
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };
    const mint = await mintToken(apiKey, attachment_id);
    const { token, token_id } = (await mint.json()) as {
      token: string;
      token_id: string;
    };

    // Backdate the expiry into the past directly in the DB.
    await prisma.attachmentToken.update({
      where: { id: token_id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await fetchByToken(token);
    expect(res.status).toBe(401);
  });

  it("once-token: consumed on first GET, second GET fails", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };
    const mint = await mintToken(apiKey, attachment_id, { once: true });
    const { token, token_id } = (await mint.json()) as {
      token: string;
      token_id: string;
    };

    const first = await fetchByToken(token);
    expect(first.status).toBe(200);
    // Drain the body. Once-tokens are claimed atomically on the request
    // path now (#199 fix) so the row is already gone when the response
    // headers arrive — but draining first keeps the assertion ordering
    // consistent with the multi-use test.
    await first.arrayBuffer();
    await waitForTokenGone(token_id);

    // Second GET — invalid (cache + DB miss).
    const second = await fetchByToken(token);
    expect(second.status).toBe(401);
  });

  it("once-token: concurrent GETs race safely — exactly one succeeds", async () => {
    // Regression test for #199. Before the fix, the once-token claim
    // (delete + revoke-cache add) ran inside setImmediate AFTER the
    // response body was enqueued — two concurrent GETs could both pass
    // the revokedAt check, both stream bytes, and both schedule the
    // delete. The fix moves the claim to an atomic deleteMany on the
    // request path before any bytes leave the relay.
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };
    const mint = await mintToken(apiKey, attachment_id, { once: true });
    const { token, token_id } = (await mint.json()) as {
      token: string;
      token_id: string;
    };

    // Fire N concurrent fetches. Single deleteMany serialises in the DB;
    // exactly one wins, the rest see count=0 and return 401. We use
    // N=8 — well above 2 so the race window is exercised but small
    // enough to keep the test fast.
    const N = 8;
    const responses = await Promise.all(
      Array.from({ length: N }, () => fetchByToken(token)),
    );
    // Drain all bodies regardless of status — otherwise the rejected
    // responses' bodies linger and slow the test.
    await Promise.all(responses.map((r) => r.arrayBuffer()));

    const successes = responses.filter((r) => r.status === 200).length;
    const failures = responses.filter((r) => r.status === 401).length;
    expect(successes).toBe(1);
    expect(failures).toBe(N - 1);

    // The winning request already deleted the row before returning.
    expect(
      await prisma.attachmentToken.findUnique({ where: { id: token_id } }),
    ).toBeNull();

    // Any subsequent fetch also fails — cache + DB miss.
    const later = await fetchByToken(token);
    expect(later.status).toBe(401);
  });

  it("multi-use token: increments use_count + writes truncated IPs", async () => {
    const { apiKey } = await seedAgent();
    const post = await upload(apiKey, await makeJpeg());
    const { attachment_id } = (await post.json()) as { attachment_id: string };
    const mint = await mintToken(apiKey, attachment_id);
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

    const row = await prisma.attachmentToken.findUnique({
      where: { id: token_id },
    });
    expect(row).not.toBeNull();
    expect(row!.useCount).toBe(2);
    expect(row!.firstSeenIpNet).toBe("203.0.113.0/24");
    expect(row!.lastSeenIpNet).toBe("198.51.100.0/24");
    expect(row!.lastUsedAt).not.toBeNull();
  });
});

// ===========================================================================
// LRU eviction (BLOB_LRU_EVICTION=true) and the rejection path
// (BLOB_LRU_EVICTION=false).
// ===========================================================================

// ===========================================================================
// Quota rejection (BLOB_LRU_EVICTION=false). A separate app instance with
// LRU off; the 4th over-cap upload is rejected with 413 quota_exceeded
// instead of evicting.
// ===========================================================================
describe("/v1/attachments — quota rejection without LRU", () => {
  let noLruApp: Hono;
  let noLruBlobDir: string;

  beforeAll(async () => {
    noLruBlobDir = mkdtempSync(join(tmpdir(), "attachment-e2e-no-lru-"));
    const config = loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
      BLOB_STORE: "filesystem",
      BLOB_STORE_FS_DIR: noLruBlobDir,
      MAX_BLOB_BYTES: String(MAX_BLOB),
      MAX_BLOBS_PER_AGENT_BYTES: String(AGENT_CAP),
      BLOB_MIME_ALLOWLIST: "image/jpeg,image/png,application/pdf",
      BLOB_LRU_EVICTION: "false",
    });
    const store = await makeBlobStore(config);
    noLruApp = buildApp(config, prisma, undefined, store);
  });

  afterAll(async () => {
    rmSync(noLruBlobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("413 quota_exceeded on the 4th over-cap upload (eviction disabled)", async () => {
    const apiKey =
      "pane_" + (await import("node:crypto")).randomBytes(16).toString("hex");
    await prisma.agent.create({
      data: {
        name: "no-lru-agent",
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
      },
    });

    const perBlob = 80 * 1024;
    const uploadTo = (body: Buffer) => {
      const fd = new FormData();
      fd.set("file", new Blob([new Uint8Array(body)], { type: "image/jpeg" }));
      return noLruApp.fetch(
        new Request("http://t/v1/attachments", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: fd,
        }),
      );
    };

    expect((await uploadTo(await makeBigJpeg(perBlob))).status).toBe(201);
    expect((await uploadTo(await makeBigJpeg(perBlob))).status).toBe(201);
    expect((await uploadTo(await makeBigJpeg(perBlob))).status).toBe(201);
    const r4 = await uploadTo(await makeBigJpeg(perBlob));
    expect(r4.status).toBe(413);
    const body = (await r4.json()) as {
      error: { code: string; details: { scope: string } };
    };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details.scope).toBe("agent");
  });
});

describe("/v1/attachments — LRU eviction on quota pressure", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("evicts the oldest agent-scope attachment when the cap would be exceeded", async () => {
    const { apiKey } = await seedAgent();
    // Same constants as the existing quota test — agent cap = 300 KB,
    // per-attachment = ~80 KB; uploading a 4th attachment would have rejected at 320KB
    // without eviction. With eviction on (default), it succeeds by deleting
    // the oldest.
    const perBlob = 80 * 1024;
    const r1 = await upload(apiKey, await makeBigJpeg(perBlob));
    const r1Body = (await r1.json()) as { attachment_id: string };
    const r2 = await upload(apiKey, await makeBigJpeg(perBlob));
    expect(r2.status).toBe(201);
    const r3 = await upload(apiKey, await makeBigJpeg(perBlob));
    expect(r3.status).toBe(201);
    // 4th would push past the cap → eviction kicks in.
    const r4 = await upload(apiKey, await makeBigJpeg(perBlob));
    expect(r4.status).toBe(201);

    // The oldest attachment (r1) should now have status=deleted.
    const r1Row = await prisma.attachment.findUnique({
      where: { id: r1Body.attachment_id },
    });
    expect(r1Row?.status).toBe("deleted");
    expect(r1Row?.deletedAt).not.toBeNull();
  });
});

// ===========================================================================
// Envelope encryption-at-rest. Spins up a SECOND app instance configured
// with BLOB_ENCRYPT_AT_REST=true and verifies the round-trip path —
// ciphertext on disk, plaintext via GET.
// ===========================================================================

describe("/v1/attachments — envelope encryption-at-rest", () => {
  let encryptedApp: Hono;
  let encryptedBlobDir: string;

  beforeAll(async () => {
    encryptedBlobDir = mkdtempSync(join(tmpdir(), "attachment-e2e-enc-"));
    const config = loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
      BLOB_STORE: "filesystem",
      BLOB_STORE_FS_DIR: encryptedBlobDir,
      BLOB_ENCRYPT_AT_REST: "true",
      // Smaller MIME allowlist so the test is unambiguous.
      BLOB_MIME_ALLOWLIST: "image/jpeg",
    });
    const encStore = await makeBlobStore(config);
    encryptedApp = buildApp(config, prisma, undefined, encStore);
  });

  afterAll(async () => {
    rmSync(encryptedBlobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("upload writes ciphertext to disk; GET decrypts back to original", async () => {
    const apiKey =
      "pane_" + (await import("node:crypto")).randomBytes(16).toString("hex");
    const agent = await prisma.agent.create({
      data: {
        name: "enc-agent",
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
      },
    });
    void agent;

    const plaintext = await makeJpeg(512);

    const fd = new FormData();
    fd.set(
      "file",
      new Blob([new Uint8Array(plaintext)], { type: "image/jpeg" }),
    );
    const post = await encryptedApp.fetch(
      new Request("http://t/v1/attachments", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: fd,
      }),
    );
    expect(post.status).toBe(201);
    const { attachment_id, sha256: plaintextSha } = (await post.json()) as {
      attachment_id: string;
      sha256: string;
    };

    // The row carries an encryptionEnvelope.
    const row = await prisma.attachment.findUnique({
      where: { id: attachment_id },
    });
    expect(row?.encryptionEnvelope).toBeTruthy();
    expect(row?.encryptionEnvelope?.length).toBeGreaterThan(40);

    // The bytes on disk are CIPHERTEXT — sha256 of the on-disk file differs
    // from the stored plaintext sha256.
    const storagePath = join(encryptedBlobDir, `attachment_${attachment_id}`);
    const onDisk = await import("node:fs/promises").then((m) =>
      m.readFile(storagePath),
    );
    const onDiskSha = (await import("node:crypto"))
      .createHash("sha256")
      .update(onDisk)
      .digest("hex");
    expect(onDiskSha).not.toBe(plaintextSha);

    // GET returns the PLAINTEXT bytes.
    const get = await encryptedApp.fetch(
      new Request(`http://t/v1/attachments/${attachment_id}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(get.status).toBe(200);
    const got = Buffer.from(await get.arrayBuffer());
    expect(got.equals(plaintext)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Bug-fix regression: GET /b/<token> must decrypt the same way the
  // agent-auth GET /v1/attachments/:id does. Pre-fix the capability URL piped raw
  // ciphertext to the response body — a participant clicking the URL got
  // unreadable random bytes instead of the image. Mirror the encrypted-
  // upload test above but route through the token endpoint.
  // ---------------------------------------------------------------------------
  it("/b/<token> decrypts ciphertext-on-disk to the original plaintext", async () => {
    const apiKey =
      "pane_" + (await import("node:crypto")).randomBytes(16).toString("hex");
    await prisma.agent.create({
      data: {
        name: "enc-agent-token",
        keyHash: hashKey(apiKey),
        keyPrefix: keyPrefix(apiKey),
      },
    });

    const plaintext = await makeJpeg(512);

    const fd = new FormData();
    fd.set(
      "file",
      new Blob([new Uint8Array(plaintext)], { type: "image/jpeg" }),
    );
    const post = await encryptedApp.fetch(
      new Request("http://t/v1/attachments", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: fd,
      }),
    );
    expect(post.status).toBe(201);
    const { attachment_id, sha256: plaintextSha } = (await post.json()) as {
      attachment_id: string;
      sha256: string;
    };

    // Mint a capability-URL token for the encrypted attachment.
    const mint = await encryptedApp.fetch(
      new Request(`http://t/v1/attachments/${attachment_id}/tokens`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(mint.status).toBe(201);
    const { token } = (await mint.json()) as { token: string };

    // The bytes on disk are CIPHERTEXT — sha256 of the on-disk file
    // must differ from the plaintext sha256. This pins the precondition
    // for the regression guard: the route is decrypting *something*, not
    // just streaming what's on disk (#203 — the doc previously warned
    // this path didn't decrypt; this assertion makes the doc claim
    // literally verified by the test).
    const storagePath = join(encryptedBlobDir, `attachment_${attachment_id}`);
    const onDisk = await import("node:fs/promises").then((m) =>
      m.readFile(storagePath),
    );
    const { createHash } = await import("node:crypto");
    const onDiskSha = createHash("sha256").update(onDisk).digest("hex");
    expect(onDiskSha).not.toBe(plaintextSha);

    // Fetch via the capability URL — must return PLAINTEXT, not the
    // ciphertext that lives on disk.
    const res = await encryptedApp.fetch(new Request(`http://t/b/${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-length")).toBe(String(plaintext.length));

    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(plaintext)).toBe(true);

    // Body sha256 round-trips with the row's plaintext sha256 and is NOT
    // the on-disk ciphertext sha — together these are the load-bearing
    // assertion that the response is plaintext.
    expect(createHash("sha256").update(got).digest("hex")).toBe(plaintextSha);
    expect(createHash("sha256").update(got).digest("hex")).not.toBe(onDiskSha);

    // The first two bytes are the JPEG magic (FF D8) — a quick sanity check
    // distinct from the sha256 comparison.
    expect(got[0]).toBe(0xff);
    expect(got[1]).toBe(0xd8);
  });
});

// ---------------------------------------------------------------------------
// Bug-fix regression (counter-test): with encryption OFF, the /b/<token>
// path stays a straight passthrough. Stored bytes == returned bytes.
// ---------------------------------------------------------------------------
describe("/b/<token> — passthrough when encryption-at-rest is off", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the stored bytes unchanged when no encryption envelope is set", async () => {
    const { apiKey } = await seedAgent();
    const payload = await makeJpeg(96);
    const post = await upload(apiKey, payload);
    const { attachment_id } = (await post.json()) as { attachment_id: string };

    // Sanity: no envelope on the row.
    const row = await prisma.attachment.findUnique({
      where: { id: attachment_id },
    });
    expect(row?.encryptionEnvelope).toBeNull();

    const mint = await mintToken(apiKey, attachment_id);
    const { token } = (await mint.json()) as { token: string };

    const res = await fetchByToken(token);
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(payload)).toBe(true);
  });
});

describe("/v1/attachments — GET list", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  async function listBlobs(
    apiKey: string,
    qs: { cursor?: string; limit?: number } = {},
  ): Promise<Response> {
    const params = new URLSearchParams();
    if (qs.cursor !== undefined) params.set("cursor", qs.cursor);
    if (qs.limit !== undefined) params.set("limit", String(qs.limit));
    const q = params.toString();
    return app.fetch(
      new Request(`http://t/v1/attachments${q ? "?" + q : ""}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
  }

  it("rejects an unauthenticated call with 401", async () => {
    const res = await app.fetch(new Request("http://t/v1/attachments"));
    expect(res.status).toBe(401);
  });

  it("returns the agent's own attachments newest-first", async () => {
    const { apiKey } = await seedAgent();
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await upload(apiKey, await makeJpeg(128));
      expect(r.status).toBe(201);
      const j = (await r.json()) as { attachment_id: string };
      created.push(j.attachment_id);
    }

    const res = await listBlobs(apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { attachment_id: string }[];
      next_cursor: string | null;
    };
    expect(body.next_cursor).toBeNull();
    expect(body.items.map((b) => b.attachment_id)).toEqual(
      created.slice().reverse(),
    );
  });

  it("excludes soft-deleted attachments", async () => {
    const { apiKey } = await seedAgent();
    const r1 = await upload(apiKey, await makeJpeg(128));
    const r2 = await upload(apiKey, await makeJpeg(128));
    const a = (await r1.json()) as { attachment_id: string };
    const b = (await r2.json()) as { attachment_id: string };

    const del = await deleteBlob(apiKey, a.attachment_id);
    expect(del.status).toBe(200);

    const res = await listBlobs(apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { attachment_id: string }[] };
    expect(body.items.map((x) => x.attachment_id)).toEqual([b.attachment_id]);
  });

  it("isolates by agent — never lists another agent's attachments", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    await upload(alice.apiKey, await makeJpeg(128));
    const bobUpload = await upload(bob.apiKey, await makeJpeg(128));
    const bobJson = (await bobUpload.json()) as { attachment_id: string };

    const res = await listBlobs(bob.apiKey);
    const body = (await res.json()) as { items: { attachment_id: string }[] };
    expect(body.items.map((x) => x.attachment_id)).toEqual([
      bobJson.attachment_id,
    ]);
  });

  it("paginates via opaque cursor and returns next_cursor when more rows exist", async () => {
    const { apiKey } = await seedAgent();
    const created: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await upload(apiKey, await makeJpeg(128));
      const j = (await r.json()) as { attachment_id: string };
      created.push(j.attachment_id);
    }

    const r1 = await listBlobs(apiKey, { limit: 2 });
    expect(r1.status).toBe(200);
    const page1 = (await r1.json()) as {
      items: { attachment_id: string }[];
      next_cursor: string | null;
    };
    expect(page1.items.length).toBe(2);
    expect(page1.next_cursor).not.toBeNull();

    const r2 = await listBlobs(apiKey, {
      limit: 2,
      cursor: page1.next_cursor!,
    });
    const page2 = (await r2.json()) as {
      items: { attachment_id: string }[];
      next_cursor: string | null;
    };
    expect(page2.items.length).toBe(2);
    expect(page2.next_cursor).toBeNull();

    // Combined pages cover every created attachment, newest first.
    const all = [
      ...page1.items.map((x) => x.attachment_id),
      ...page2.items.map((x) => x.attachment_id),
    ];
    expect(all).toEqual(created.slice().reverse());
  });

  it("rejects an out-of-range limit with 400", async () => {
    const { apiKey } = await seedAgent();
    const r = await listBlobs(apiKey, { limit: 101 });
    expect(r.status).toBe(400);
  });

  it("rejects an obviously malformed cursor with 400", async () => {
    const { apiKey } = await seedAgent();
    const r = await listBlobs(apiKey, { cursor: "not-a-valid-cursor" });
    expect(r.status).toBe(400);
  });
});

describe("/v1/attachments/:id/tokens — GET list", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  async function listTokens(
    apiKey: string,
    attachmentId: string,
  ): Promise<Response> {
    return app.fetch(
      new Request(`http://t/v1/attachments/${attachmentId}/tokens`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
  }

  it("rejects an unauthenticated call with 401", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/attachments/cmprefix0000000000000000/tokens"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 attachment_not_found when the agent doesn't own the attachment", async () => {
    const alice = await seedAgent();
    const bob = await seedAgent();
    const upl = await upload(alice.apiKey, await makeJpeg(128));
    const ablob = (await upl.json()) as { attachment_id: string };

    const res = await listTokens(bob.apiKey, ablob.attachment_id);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("attachment_not_found");
  });

  it("lists active + revoked tokens with the expected audit shape (and never returns the plaintext)", async () => {
    const { apiKey } = await seedAgent();
    const upl = await upload(apiKey, await makeJpeg(128));
    const { attachment_id } = (await upl.json()) as { attachment_id: string };

    const m1 = await mintToken(apiKey, attachment_id, { once: true });
    const m2 = await mintToken(apiKey, attachment_id);
    const t1 = (await m1.json()) as {
      token: string;
      token_id: string;
      token_prefix: string;
    };
    const t2 = (await m2.json()) as { token: string; token_id: string };

    // Revoke t2 so the listing must pane revoked_at as non-null.
    const rev = await revokeToken(apiKey, attachment_id, t2.token_id);
    expect(rev.status).toBe(200);

    const res = await listTokens(apiKey, attachment_id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachment_id: string;
      items: Array<{
        token_id: string;
        token_prefix: string;
        expires_at: string;
        once: boolean;
        created_at: string;
        last_used_at: string | null;
        use_count: number;
        revoked_at: string | null;
        // The plaintext MUST NOT appear.
        token?: never;
      }>;
    };
    expect(body.attachment_id).toBe(attachment_id);
    expect(body.items.length).toBe(2);

    // Newest-first ordering — t2 was minted last.
    const ids = body.items.map((x) => x.token_id);
    expect(ids).toEqual([t2.token_id, t1.token_id]);

    // Audit shape sanity.
    const a = body.items.find((x) => x.token_id === t1.token_id)!;
    expect(a.token_prefix).toBe(t1.token_prefix);
    expect(a.once).toBe(true);
    expect(a.use_count).toBe(0);
    expect(a.last_used_at).toBeNull();
    expect(a.revoked_at).toBeNull();

    const b = body.items.find((x) => x.token_id === t2.token_id)!;
    expect(b.revoked_at).not.toBeNull();

    // No row carries a `token` field — that's invariant.
    for (const item of body.items) {
      expect((item as Record<string, unknown>).token).toBeUndefined();
    }
  });

  it("returns an empty list (not 404) for a attachment with no tokens yet", async () => {
    const { apiKey } = await seedAgent();
    const upl = await upload(apiKey, await makeJpeg(128));
    const { attachment_id } = (await upl.json()) as { attachment_id: string };

    const res = await listTokens(apiKey, attachment_id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attachment_id: string;
      items: unknown[];
    };
    expect(body.attachment_id).toBe(attachment_id);
    expect(body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F-03 / F-12: SHIPPED-DEFAULT and empty BLOB_MIME_ALLOWLIST behaviour.
//
// The main suite above pins a restricted allowlist for determinism. These
// tests build dedicated apps to exercise (a) the actual shipped default and
// (b) the accidental-empty case, which must fall back to the secure default
// (never accept-any).
// ---------------------------------------------------------------------------
describe("/v1/attachments — default & empty allowlist (F-03 / F-12)", () => {
  let defaultApp: Hono;
  let emptyApp: Hono;
  let dir1: string;
  let dir2: string;

  beforeAll(async () => {
    dir1 = mkdtempSync(join(tmpdir(), "attachment-default-allow-"));
    dir2 = mkdtempSync(join(tmpdir(), "attachment-empty-allow-"));

    // No BLOB_MIME_ALLOWLIST override → the shipped secure default
    // (image/jpeg,image/png,image/gif,image/webp,application/pdf — NO svg).
    const defaultConfig = loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
      BLOB_STORE: "filesystem",
      BLOB_STORE_FS_DIR: dir1,
      MAX_BLOB_BYTES: String(MAX_BLOB),
      RATE_LIMIT: "0",
    });
    defaultApp = buildApp(
      defaultConfig,
      prisma,
      undefined,
      await makeBlobStore(defaultConfig),
    );

    // Explicitly EMPTY allowlist → must fall back to the secure default, NOT
    // accept-any. So svg is still rejected.
    const emptyConfig = loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
      BLOB_STORE: "filesystem",
      BLOB_STORE_FS_DIR: dir2,
      MAX_BLOB_BYTES: String(MAX_BLOB),
      BLOB_MIME_ALLOWLIST: "",
      RATE_LIMIT: "0",
    });
    emptyApp = buildApp(
      emptyConfig,
      prisma,
      undefined,
      await makeBlobStore(emptyConfig),
    );
  });

  afterAll(() => {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  async function postTo(
    targetApp: Hono,
    apiKey: string,
    body: Buffer,
    declaredMime: string,
    filename: string,
  ): Promise<Response> {
    const fd = new FormData();
    fd.set(
      "file",
      new Blob([new Uint8Array(body)], { type: declaredMime }),
      filename,
    );
    return targetApp.fetch(
      new Request("http://t/v1/attachments", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: fd,
      }),
    );
  }

  const svgPayload = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>',
    "utf8",
  );

  it("rejects image/svg+xml under the shipped default allowlist", async () => {
    const { apiKey } = await seedAgent();
    const res = await postTo(
      defaultApp,
      apiKey,
      svgPayload,
      "image/svg+xml",
      "x.svg",
    );
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("mime_disallowed");
  });

  it("still accepts a raster PNG under the shipped default allowlist", async () => {
    const { apiKey } = await seedAgent();
    const png = await makePng();
    const res = await postTo(defaultApp, apiKey, png, "image/png", "x.png");
    expect(res.status).toBe(201);
    const json = (await res.json()) as { mime: string };
    expect(json.mime).toBe("image/png");
  });

  it("an empty BLOB_MIME_ALLOWLIST falls back to the default — svg still rejected (F-12, no accept-any)", async () => {
    const { apiKey } = await seedAgent();
    const res = await postTo(
      emptyApp,
      apiKey,
      svgPayload,
      "image/svg+xml",
      "x.svg",
    );
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("mime_disallowed");
  });

  it("an empty BLOB_MIME_ALLOWLIST still accepts raster PNG (default, not reject-all)", async () => {
    const { apiKey } = await seedAgent();
    const png = await makePng();
    const res = await postTo(emptyApp, apiKey, png, "image/png", "x.png");
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// F-13: SVG opted back IN via BLOB_MIME_ALLOWLIST.
//
// The default rejects svg (covered above). When an operator re-enables it,
// an accepted SVG must be RASTERISED to PNG — the stored row's mime is
// image/png, and the served bytes carry no <script> / onload / javascript: /
// foreignObject markup. This is the security-relevant path: it only matters
// once svg is allowed, but then sanitisation MUST kick in.
// ---------------------------------------------------------------------------
describe("/v1/attachments — SVG opted in is rasterised to PNG (F-13)", () => {
  let svgApp: Hono;
  let svgDir: string;

  beforeAll(async () => {
    svgDir = mkdtempSync(join(tmpdir(), "attachment-svg-allow-"));
    const svgConfig = loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
      BLOB_STORE: "filesystem",
      BLOB_STORE_FS_DIR: svgDir,
      MAX_BLOB_BYTES: String(MAX_BLOB),
      MAX_BLOBS_PER_AGENT_BYTES: String(AGENT_CAP),
      // Operator explicitly opts SVG back in.
      BLOB_MIME_ALLOWLIST: "image/png,image/svg+xml",
      RATE_LIMIT: "0",
    });
    svgApp = buildApp(
      svgConfig,
      prisma,
      undefined,
      await makeBlobStore(svgConfig),
    );
  });

  afterAll(() => {
    rmSync(svgDir, { recursive: true, force: true });
  });

  const scriptedSvg = Buffer.from(
    `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="24" height="24" onload="alert('onload')">
  <rect width="24" height="24" fill="#22aa55"/>
  <script type="application/javascript">alert('inline-script')</script>
  <a xlink:href="javascript:alert('xlink')"><rect width="4" height="4"/></a>
  <foreignObject width="8" height="8"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert('fo')"/></body></foreignObject>
</svg>`,
    "utf8",
  );

  async function postSvg(apiKey: string, body: Buffer): Promise<Response> {
    const fd = new FormData();
    fd.set(
      "file",
      new Blob([new Uint8Array(body)], { type: "image/svg+xml" }),
      "x.svg",
    );
    return svgApp.fetch(
      new Request("http://t/v1/attachments", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: fd,
      }),
    );
  }

  // Download must go through svgApp too — its FilesystemBlobStore points at
  // svgDir, where the rasterised bytes were written (the main `app` uses a
  // different blob dir, so its store can't see them even though the row is
  // in the shared DB).
  async function getSvgBlob(
    apiKey: string,
    attachmentId: string,
  ): Promise<Response> {
    return svgApp.fetch(
      new Request(`http://t/v1/attachments/${attachmentId}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
  }

  it("accepts the SVG, stores it as image/png, and the served bytes carry no script", async () => {
    const { apiKey } = await seedAgent();
    const post = await postSvg(apiKey, scriptedSvg);
    expect(post.status).toBe(201);
    const json = (await post.json()) as {
      attachment_id: string;
      mime: string;
      sha256: string;
    };
    // Stored mime is rasterised PNG, NOT image/svg+xml.
    expect(json.mime).toBe("image/png");

    // Fetch the stored bytes back via the agent download path.
    const get = await getSvgBlob(apiKey, json.attachment_id);
    expect(get.status).toBe(200);
    // Now that it's a raster PNG, it serves inline (vs. attachment for svg).
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(get.headers.get("content-disposition")).toBe("inline");

    const buf = Buffer.from(await get.arrayBuffer());
    // It's a real PNG.
    const sharp = (await import("sharp")).default;
    expect((await sharp(buf).metadata()).format).toBe("png");

    // No executable / SVG markup survived.
    const text = buf.toString("latin1");
    for (const needle of [
      "<script",
      "onload",
      "javascript:",
      "onerror",
      "foreignObject",
      "<svg",
    ]) {
      expect(text, `"${needle}" survived rasterisation`).not.toContain(needle);
    }

    // sha256 returned matches the stored (rasterised) bytes, not the svg.
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(buf).digest("hex")).toBe(json.sha256);
  });
});

// ---------------------------------------------------------------------------
// Polling helpers.
//
// waitForUseCount: the per-hit audit metadata (useCount / lastUsedAt /
// IP-net columns) for multi-use tokens fires in a setImmediate after the
// response body is enqueued, so the test needs to wait for the DB to catch
// up. A fixed setTimeout(50) would be a flake source; polling caps at 1s
// and bails loudly if it never converges.
//
// waitForTokenGone: post-#199 fix, once-token deletion is SYNCHRONOUS on
// the request path — the row is already gone by the time the response
// headers arrive. This helper is effectively a no-op for once-tokens
// (the first findUnique returns null) but is kept as a defence-in-depth
// guard against a future refactor that moves the delete back off-path.
// ---------------------------------------------------------------------------
async function waitForUseCount(
  tokenId: string,
  expected: number,
  deadlineMs = 1000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const row = await prisma.attachmentToken.findUnique({
      where: { id: tokenId },
    });
    if (row && row.useCount >= expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `AttachmentToken ${tokenId} did not reach useCount=${expected} within ${deadlineMs}ms`,
  );
}

async function waitForTokenGone(
  tokenId: string,
  deadlineMs = 1000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const row = await prisma.attachmentToken.findUnique({
      where: { id: tokenId },
    });
    if (!row) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `AttachmentToken ${tokenId} still exists after ${deadlineMs}ms (once-consumption stuck)`,
  );
}
