// BlobStore factory — selects the backend from config + lazy-loads its SDK.
//
// The Azure backend imports `@azure/storage-blob` and `@azure/identity`
// (~2 MB of code + transitive dependencies); a self-host that never enables
// Azure should not load that. The factory is the seam: BLOB_STORE=filesystem
// never imports the Azure module (the dynamic `import("./azure.js")` only
// runs in the azure branch), and vice versa.

import type { Config } from "../config.js";
import type { BlobStore } from "./store.js";
import { FilesystemBlobStore } from "./filesystem.js";

/**
 * Build the configured BlobStore. Call once at relay startup; the returned
 * instance is shared across the lifetime of the process.
 *
 * Filesystem: validates / creates the storage directory and refuses to start
 * if it's world-readable. Azure: dynamic-imports the Azure SDK + the
 * AzureBlobStore module, builds either a connection-string client (dev /
 * Azurite) or a managed-identity client (production), and verifies the
 * container exists / creates it if missing.
 */
export async function makeBlobStore(config: Config): Promise<BlobStore> {
  switch (config.BLOB_STORE) {
    case "filesystem": {
      const store = new FilesystemBlobStore({ dir: config.BLOB_STORE_FS_DIR });
      await store.init();
      return store;
    }
    case "azure": {
      if (!config.BLOB_STORE_AZURE_CONTAINER) {
        throw new Error(
          "BLOB_STORE=azure requires BLOB_STORE_AZURE_CONTAINER to be set",
        );
      }
      // Dynamic import: filesystem self-host never pulls @azure/storage-blob.
      const { AzureBlobStore } = await import("./azure.js");

      const auth = config.BLOB_STORE_AZURE_CONNECTION_STRING
        ? {
            kind: "connectionString" as const,
            value: config.BLOB_STORE_AZURE_CONNECTION_STRING,
          }
        : config.BLOB_STORE_AZURE_ACCOUNT_URL
          ? {
              kind: "accountUrl" as const,
              url: config.BLOB_STORE_AZURE_ACCOUNT_URL,
            }
          : null;

      if (!auth) {
        throw new Error(
          "BLOB_STORE=azure needs either BLOB_STORE_AZURE_CONNECTION_STRING (dev/Azurite) or BLOB_STORE_AZURE_ACCOUNT_URL (managed identity)",
        );
      }

      const store = new AzureBlobStore({
        container: config.BLOB_STORE_AZURE_CONTAINER,
        auth,
        presignTtlSeconds: config.BLOB_PRESIGN_TTL_SECONDS,
      });
      await store.init();
      return store;
    }
  }
}
