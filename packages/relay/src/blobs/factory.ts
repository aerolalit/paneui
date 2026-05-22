// BlobStore factory — selects the backend from config + lazy-loads its SDK.
//
// The Azure backend imports `@azure/storage-blob` and `@azure/identity`
// (~2 MB of code + transitive dependencies); a self-host that never enables
// Azure should not load that. The factory is the seam: BLOB_STORE=filesystem
// never imports the Azure module (the dynamic `import("./azure.js")` only
// runs in the azure branch), and vice versa.
//
// As of #154, the Azure SDK packages live in optionalDependencies — npm
// won't install them on a self-host install that skips optionals. The
// dynamic import below catches the ERR_MODULE_NOT_FOUND that produces and
// rethrows with a single clear, actionable message (mirrors the `ioredis`
// pattern in src/redis.ts).

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
      // The SDK lives in optionalDependencies (#154) — a missing install
      // surfaces as ERR_MODULE_NOT_FOUND from inside azure.ts's static
      // imports. Catch it once here and rethrow with a single actionable
      // message; mirrors how src/redis.ts handles the missing-ioredis case.
      let azureModule: typeof import("./azure.js");
      try {
        azureModule = await import("./azure.js");
      } catch (e) {
        if (isModuleNotFound(e)) {
          throw new Error(
            "BLOB_STORE=azure is set but the optional Azure SDK packages are " +
              "not installed — run `npm install @azure/storage-blob @azure/identity` " +
              "(they ship in optionalDependencies; a self-host install with " +
              "BLOB_STORE=filesystem does not need them).",
            { cause: e },
          );
        }
        throw e;
      }
      const { AzureBlobStore } = azureModule;

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

/**
 * Heuristic for "the dynamic import failed because @azure/* isn't installed,"
 * vs any other failure mode (azure.ts itself throwing at module init, a
 * config-validation error from inside the constructor, etc.). Node's loader
 * raises ERR_MODULE_NOT_FOUND for a bare-specifier import that can't be
 * resolved.
 */
function isModuleNotFound(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: string }).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    const msg = (e as { message?: string }).message ?? "";
    // Make sure the missing module is actually an Azure one — we don't want
    // to swallow a missing internal module under this branch.
    return /@azure\/(storage-blob|identity)/.test(msg);
  }
  return false;
}
