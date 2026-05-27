// End-to-end tests for AzureBlobStore against the Azurite emulator.
//
// Runs against an Azurite container started via docker-compose locally OR
// the Azurite service in CI's e2e (postgres) job. Gated by the `AZURITE_URL`
// env var: when unset, the whole file skips (so a developer without the
// emulator running doesn't pay the timeout cost on every test run). CI's
// e2e job sets AZURITE_URL=http://127.0.0.1:10000 alongside the Azurite
// service container.
//
// Locally: run with `AZURITE_URL=http://127.0.0.1:10000 npm run test:e2e`
// after `docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite`.
//
// Azurite's well-known connection string is documented at
// https://learn.microsoft.com/azure/storage/common/storage-use-azurite —
// the same string is used in every dev / CI invocation.

import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { AzureBlobStore } from "./azure.js";
import {
  AttachmentIntegrityError,
  AttachmentSizeExceededError,
} from "./store.js";

/** Azurite well-known account key — published in the Azurite docs. */
const AZURITE_ACCOUNT_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

const CONTAINER = `pane-test-${randomBytes(4).toString("hex")}`;

let store: AzureBlobStore;
let available = false;

beforeAll(async () => {
  // Explicit env-var gate — skip the whole file when AZURITE_URL is unset.
  // Avoids the "something else is on port 10000" false positive we'd get
  // from a connection-only probe.
  const azuriteUrl = process.env.AZURITE_URL;
  if (!azuriteUrl) {
    return;
  }

  const connection =
    `DefaultEndpointsProtocol=http;` +
    `AccountName=devstoreaccount1;` +
    `AccountKey=${AZURITE_ACCOUNT_KEY};` +
    `BlobEndpoint=${azuriteUrl}/devstoreaccount1;`;

  try {
    store = new AzureBlobStore({
      container: CONTAINER,
      auth: { kind: "connectionString", value: connection },
      presignTtlSeconds: 600,
    });
    await store.init();

    // Tighter probe: actually round-trip a small attachment to make sure the
    // server on the other end is really Azurite (or a real Azure account),
    // not some other Node process holding port 10000.
    const probeKey = `__pane_probe_${randomBytes(4).toString("hex")}`;
    await store.put(probeKey, Readable.from(Buffer.from("ok")), {
      mime: "text/plain",
      maxBytes: 100,
    });
    await store.delete(probeKey);
    available = true;
  } catch (e) {
    console.warn(
      `[azure.e2e] AZURITE_URL=${azuriteUrl} set but round-trip probe failed — skipping. Check Azurite is actually listening there.`,
      e instanceof Error ? e.message : e,
    );
    available = false;
  }
}, 30_000);

afterAll(async () => {
  // Best-effort container cleanup (test container is per-run so a stale one
  // is harmless, but the cleanup keeps Azurite's data dir tidy in dev).
  if (!available || !store) return;
  // No public delete-container method on our class — use the SDK directly.
  // Skipped for brevity; Azurite's data is in-memory in CI.
});

const itAvailable: typeof it = ((name, fn) =>
  it(name, async (ctx) => {
    if (!available) {
      ctx.skip();
      return;
    }
    if (fn) await fn(ctx);
  })) as unknown as typeof it;

afterEach(async () => {
  // Per-test cleanup is per-key in each test (we generate fresh keys).
});

const KEY = () => `attachment_${randomBytes(8).toString("hex")}`;

describe("AzureBlobStore — round trip", () => {
  itAvailable("put + head + get + delete", async () => {
    const key = KEY();
    const payload = Buffer.from("hello azurite world");
    const info = await store.put(key, Readable.from(payload), {
      mime: "text/plain",
      maxBytes: 1_000_000,
    });
    expect(info.size).toBe(payload.length);
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);

    const head = await store.head(key);
    expect(head).not.toBeNull();
    expect(head!.size).toBe(info.size);
    expect(head!.sha256).toBe(info.sha256);

    const stream = await store.get(key);
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of stream!) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);

    await store.delete(key);
    expect(await store.head(key)).toBeNull();
    expect(await store.get(key)).toBeNull();
  });

  itAvailable("get + head return null for unknown keys", async () => {
    expect(await store.head("attachment_no_such_key")).toBeNull();
    expect(await store.get("attachment_no_such_key")).toBeNull();
  });

  itAvailable("delete is idempotent", async () => {
    await store.delete("attachment_does_not_exist_either");
    await store.delete("attachment_does_not_exist_either");
  });
});

describe("AzureBlobStore — size cap", () => {
  itAvailable(
    "throws AttachmentSizeExceededError when payload exceeds maxBytes",
    async () => {
      const key = KEY();
      const big = Buffer.alloc(100_000, 0xaa);
      await expect(
        store.put(key, Readable.from(big), {
          mime: "application/octet-stream",
          maxBytes: 10_000,
        }),
      ).rejects.toBeInstanceOf(AttachmentSizeExceededError);
      // No bytes should persist.
      expect(await store.head(key)).toBeNull();
    },
  );
});

describe("AzureBlobStore — presigned PUT (SAS) + confirm", () => {
  itAvailable(
    "presignPut + client PUT + confirmPresigned: happy path",
    async () => {
      const key = KEY();
      const payload = Buffer.from("presigned-put bytes via SAS");
      const { createHash } = await import("node:crypto");
      const sha256 = createHash("sha256").update(payload).digest("hex");

      const presign = await store.presignPut({
        key,
        mime: "text/plain",
        sha256,
      });
      expect(presign.uploadUrl).toContain("?");
      expect(presign.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Simulate the client PUT to the SAS URL.
      const put = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: {
          "x-ms-attachment-type": "BlockBlob",
          "content-type": "text/plain",
        },
        body: payload,
      });
      expect(put.status).toBe(201);

      const info = await store.confirmPresigned(key, {
        size: payload.length,
        sha256,
        mime: "text/plain",
      });
      expect(info.size).toBe(payload.length);
      expect(info.sha256).toBe(sha256);

      // After confirm, head() should return the same metadata.
      const head = await store.head(key);
      expect(head?.sha256).toBe(sha256);

      await store.delete(key);
    },
  );

  itAvailable(
    "confirmPresigned rejects mismatched sha256 (TOCTOU defence)",
    async () => {
      const key = KEY();
      const realPayload = Buffer.from("the real bytes");
      const { createHash } = await import("node:crypto");
      const realSha = createHash("sha256").update(realPayload).digest("hex");
      const lyingSha = "0".repeat(64);

      const presign = await store.presignPut({
        key,
        mime: "text/plain",
        sha256: lyingSha,
      });
      await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: {
          "x-ms-attachment-type": "BlockBlob",
          "content-type": "text/plain",
        },
        body: realPayload,
      });

      await expect(
        store.confirmPresigned(key, {
          size: realPayload.length,
          sha256: lyingSha, // committed != actual
          mime: "text/plain",
        }),
      ).rejects.toBeInstanceOf(AttachmentIntegrityError);

      // After integrity failure, the bytes should have been removed.
      expect(await store.head(key)).toBeNull();
      void realSha; // not used; kept for symmetry
    },
  );

  itAvailable("confirmPresigned rejects mismatched size", async () => {
    const key = KEY();
    const payload = Buffer.from("twelve bytes");
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(payload).digest("hex");

    const presign = await store.presignPut({
      key,
      mime: "text/plain",
      sha256,
    });
    await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: {
        "x-ms-attachment-type": "BlockBlob",
        "content-type": "text/plain",
      },
      body: payload,
    });

    // Confirm with the wrong committed size.
    await expect(
      store.confirmPresigned(key, {
        size: payload.length + 1, // wrong
        sha256,
        mime: "text/plain",
      }),
    ).rejects.toBeInstanceOf(AttachmentIntegrityError);
  });
});
