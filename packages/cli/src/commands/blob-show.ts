// `pane blob show <blob-id>` — print a blob's metadata.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

const KNOWN_FLAGS: string[] = [];
const KNOWN_BOOLS: string[] = [];

export const blobShowHelp = `pane blob show — print a blob's metadata (no bytes)

Usage:
  pane blob show <blob-id> [options]

Looks up the blob by id and prints its BlobRef metadata — owner, scope,
mime, size, sha256, etc. Does NOT download the bytes; use 'pane blob
download' for that.

Options:
  --url <url>            Relay base URL (overrides PANE_URL).
  --api-key <key>        Agent API key (overrides PANE_API_KEY).
  -h, --help             Show this help.

Output (stdout, JSON):
  BlobRef`;

export async function runBlobShow(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane blob show");

  const blobId = args.positionals[0];
  if (!blobId) {
    fail("missing <blob-id> — 'pane blob show <blob-id>'", "invalid_args");
  }
  const client = makeClient(args);
  try {
    const ref = await client.getBlob(blobId!);
    printJson(ref);
  } catch (e) {
    failFromError(e);
  }
}
