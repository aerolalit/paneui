// Public surface of the blobs module. Route handlers + tests import from
// here, never reach into individual implementations directly.

export {
  BlobIntegrityError,
  BlobSizeExceededError,
  type BlobObjectInfo,
  type BlobStore,
  type WriteOpts,
} from "./store.js";
// AzureBlobStore is intentionally NOT exported here — the factory dynamic-
// imports it so a `BLOB_STORE=filesystem` self-host never pulls @azure/*
// into its bundle. Tests that need the Azure module import it directly from
// `./azure.js` so the cost is opt-in.
export { makeBlobStore } from "./factory.js";
export { FilesystemBlobStore } from "./filesystem.js";
export { sniffMime, isMimeAllowed } from "./mime-sniff.js";
export {
  generateBlobToken,
  hashBlobToken,
  looksLikeBlobToken,
} from "./tokens.js";
export { truncateIp } from "./ip-truncate.js";
export { makeRevokeCache, type RevokeCache } from "./revoke-cache.js";
export {
  normaliseImage,
  isNormalisable,
  ImageNormalisationError,
  type NormaliseResult,
} from "./normalize.js";
export { collectBlobRefs, assertBlobsAccessibleByAgent } from "./ref-access.js";
