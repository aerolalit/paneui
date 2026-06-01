// Unit test for makeBlobStore — install gating (#154).
//
// Promise: `BLOB_STORE=filesystem` NEVER triggers an import of
// `@azure/storage-blob` or `@azure/identity`. Self-hosters who skip
// optionalDependencies on `npm install` don't get a runtime crash from a
// stray Azure import; the filesystem branch is a static-import-only path.
//
// The test stubs both Azure modules with a factory that THROWS on import
// (vitest's vi.mock factory is invoked when the module is first
// require'd / imported). If the filesystem branch ever accidentally pulls
// in azure.ts — which static-imports both packages — the throw panes
// and the test fails loudly.
//
// We don't separately test the "Azure SDK missing → clean error" rethrow
// path because vitest's mock-factory hoisting makes it hard to simulate
// ERR_MODULE_NOT_FOUND faithfully. The rethrow in factory.ts is small,
// obvious, and follows the same pattern as src/redis.ts's `loadIoredis()`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "attachment-factory-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("makeBlobStore — install gating (#154)", () => {
  it("BLOB_STORE=filesystem does NOT import the Azure SDK", async () => {
    // Mock both Azure packages to throw at import time. If the filesystem
    // branch pulls in azure.ts (which has `import {...} from "@azure/..."`
    // at the top), those throws will propagate out of `makeBlobStore` and
    // fail the test.
    vi.doMock("@azure/storage-blob", () => {
      throw new Error(
        "TEST FAILURE: @azure/storage-blob was imported during a filesystem-only makeBlobStore call",
      );
    });
    vi.doMock("@azure/identity", () => {
      throw new Error(
        "TEST FAILURE: @azure/identity was imported during a filesystem-only makeBlobStore call",
      );
    });

    // Re-import the factory after the mocks are registered (vi.resetModules
    // in afterEach + dynamic import here gives a fresh module graph).
    const { makeBlobStore } = await import("./factory.js");
    const store = await makeBlobStore({
      BLOB_STORE: "filesystem",
      BLOB_STORE_FS_DIR: dir,
      BLOB_STORE_AZURE_CONTAINER: "",
      BLOB_STORE_AZURE_CONNECTION_STRING: "",
      BLOB_STORE_AZURE_ACCOUNT_URL: "",
      BLOB_PRESIGN_TTL_SECONDS: 600,
      // The factory's Config parameter has many fields the filesystem
      // branch never reads; cast through unknown so we don't have to
      // construct the full shape.
    } as unknown as Parameters<typeof makeBlobStore>[0]);

    expect(store).toBeDefined();
    expect(store.constructor.name).toBe("FilesystemBlobStore");
  });
});
