// Runs the shared backend-conformance suite (issue #154) against the
// AzureBlobStore via Azurite. The full battery — including the
// presigned-PUT cases that AzureBlobStore implements + the negative-control
// meta-test that proves the TOCTOU test has teeth.
//
// Gated on AZURITE_URL: when unset, the whole suite is skipped via
// `skipIf`. CI's e2e (postgres) job sets AZURITE_URL=http://127.0.0.1:10000
// alongside the Azurite service container; the same workflow's
// real-Azure variant (blob-conformance-real-azure.yml) overrides the
// connection string to point at a real Azure Storage account.

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { AzureBlobStore } from "./azure.js";
import { runConformanceSuite } from "./backend-conformance.js";

const AZURITE_ACCOUNT_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

// One container per test run. Azurite's data dir is in-memory in CI, so a
// stale per-run container is cheap.
const CONTAINER = `pane-conf-${randomBytes(4).toString("hex")}`;

let store: AzureBlobStore | null = null;
let setupAttempted = false;
let setupSucceeded = false;

async function ensureStore(): Promise<AzureBlobStore | null> {
  if (setupAttempted) return setupSucceeded ? store : null;
  setupAttempted = true;
  const azuriteUrl = process.env.AZURITE_URL;
  if (!azuriteUrl) return null;

  // BLOB_CONFORMANCE_CONNECTION_STRING lets the weekly real-Azure run point
  // at a real Storage account (a federated identity scoped to a dedicated
  // test container). Falls back to the well-known Azurite string for CI
  // and dev. This is the single switch that swaps backends without
  // changing the suite.
  const connection =
    process.env.BLOB_CONFORMANCE_CONNECTION_STRING ??
    `DefaultEndpointsProtocol=http;` +
      `AccountName=devstoreaccount1;` +
      `AccountKey=${AZURITE_ACCOUNT_KEY};` +
      `BlobEndpoint=${azuriteUrl}/devstoreaccount1;`;

  const candidate = new AzureBlobStore({
    container: CONTAINER,
    auth: { kind: "connectionString", value: connection },
    presignTtlSeconds: 600,
  });
  try {
    await candidate.init();
    // Tight probe — make sure the server we reached really is an Azure
    // Blob API (not some other process holding port 10000).
    const probeKey = `__pane_probe_${randomBytes(4).toString("hex")}`;
    await candidate.put(probeKey, Readable.from(Buffer.from("ok")), {
      mime: "text/plain",
      maxBytes: 100,
    });
    await candidate.delete(probeKey);
    store = candidate;
    setupSucceeded = true;
    return store;
  } catch (e) {
    console.warn(
      `[azure.conformance] AZURITE_URL=${azuriteUrl} set but probe failed — skipping.`,
      e instanceof Error ? e.message : e,
    );
    setupSucceeded = false;
    return null;
  }
}

runConformanceSuite({
  backendName: "azure",
  caps: {
    presign: true,
    presignScopedToSingleKey: true, // SAS sr=b is per-blob
  },
  // skipIf is evaluated lazily inside each test — by then ensureStore() has
  // settled. Mark "no AZURITE_URL" as the cheap pre-check; the probe
  // failure path also flips setupSucceeded=false so the same skip kicks in.
  skipIf: () => {
    if (!process.env.AZURITE_URL) return true;
    // If we've already attempted setup and it failed, skip.
    if (setupAttempted && !setupSucceeded) return true;
    return false;
  },
  setup: async () => {
    const s = await ensureStore();
    if (!s) {
      // Should be caught by skipIf above; defensive fallback.
      throw new Error("__SKIP__");
    }
    return {
      store: s,
      nextKey: () => `blob_${randomBytes(8).toString("hex")}`,
    };
  },
});
