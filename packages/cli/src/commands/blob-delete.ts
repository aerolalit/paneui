// `pane blob delete <blob-id>` — soft-delete a blob.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

const KNOWN_FLAGS: string[] = [];
const KNOWN_BOOLS: string[] = [];

export const blobDeleteHelp = `pane blob delete — soft-delete a blob

Usage:
  pane blob delete <blob-id> [options]

Marks the blob as deleted (DELETE /v1/blobs/:id). Idempotent: deleting an
already-deleted blob still returns success. Tokens minted against this blob
become unusable.

Options:
  --url <url>            Relay base URL (overrides PANE_URL).
  --api-key <key>        Agent API key (overrides PANE_API_KEY).
  -h, --help             Show this help.

Output (stdout, JSON):
  { blob_id, deleted: true }`;

export async function runBlobDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane blob delete");

  const blobId = args.positionals[0];
  if (!blobId) {
    fail("missing <blob-id> — 'pane blob delete <blob-id>'", "invalid_args");
  }
  const client = makeClient(args);
  try {
    const r = await client.deleteBlob(blobId!);
    printJson({ blob_id: blobId, ...r });
  } catch (e) {
    failFromError(e);
  }
}
