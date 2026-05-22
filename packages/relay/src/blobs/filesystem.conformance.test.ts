// Runs the shared backend-conformance suite (issue #154) against the
// FilesystemBlobStore. Filesystem doesn't ship presign on main, so the
// presigned-PUT cases are skipped by `caps.presign = false` — they show
// up as skipped in the report rather than silently disappearing.
//
// The non-presign cases (1, 5, 6, 7, 8) cover the durability + atomicity
// guarantees that matter for the self-host story.

import { afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemBlobStore } from "./filesystem.js";
import { runConformanceSuite } from "./backend-conformance.js";

let dir: string;
let store: FilesystemBlobStore;

afterEach(() => {
  // Best-effort cleanup; tests share the dir within a `setup()` call.
  try {
    if (dir) chmodSync(dir, 0o700);
  } catch {
    /* dir may already be gone */
  }
});

runConformanceSuite({
  backendName: "filesystem",
  caps: {
    presign: false, // FilesystemBlobStore doesn't implement presignPut on main
    presignScopedToSingleKey: false,
  },
  setup: async () => {
    dir = mkdtempSync(join(tmpdir(), "blob-fs-conformance-"));
    store = new FilesystemBlobStore({ dir });
    await store.init();
    return {
      store,
      nextKey: () => `blob_${randomBytes(8).toString("hex")}`,
      cleanup: async () => {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
