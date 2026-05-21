// BlobStore factory — selects the backend from config + lazy-loads its SDK.
//
// The Azure backend imports `@azure/storage-blob` (~2 MB of code + transitive
// dependencies); a self-host that never enables Azure should not load it.
// The factory is the seam — `BLOB_STORE=filesystem` never imports the Azure
// module, and vice versa.
//
// In v0.1.0 only `filesystem` is implemented. `azure` throws a clear error
// pointing at the tracking issue — added in the next PR of the stack.

import type { Config } from "../config.js";
import type { BlobStore } from "./store.js";
import { FilesystemBlobStore } from "./filesystem.js";

/**
 * Build the configured BlobStore. Call once at relay startup; the returned
 * instance is shared across the lifetime of the process.
 *
 * Filesystem: validates / creates the storage directory and refuses to start
 * if it's world-readable. Azure: stubbed in this PR.
 */
export async function makeBlobStore(config: Config): Promise<BlobStore> {
  switch (config.BLOB_STORE) {
    case "filesystem": {
      const store = new FilesystemBlobStore({ dir: config.BLOB_STORE_FS_DIR });
      await store.init();
      return store;
    }
    case "azure": {
      // Wired in PR #3 (feat/blobs-azure-sas). The SDK is deliberately not
      // imported here so a filesystem self-host doesn't pull @azure/storage-blob
      // into its bundle.
      throw new Error(
        "BLOB_STORE=azure is not yet wired — tracking in issue #152 (PR feat/blobs-azure-sas). Set BLOB_STORE=filesystem for v0.1.0 foundation builds.",
      );
    }
  }
}
