// `pane attachment show <attachment-id>` — print a attachment's metadata.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

const KNOWN_FLAGS: string[] = [];
const KNOWN_BOOLS: string[] = [];

export const blobShowHelp = `pane attachment show — print a attachment's metadata (no bytes)

Usage:
  pane attachment show <attachment-id> [options]

Looks up the attachment by id and prints its AttachmentRef metadata — owner, scope,
mime, size, sha256, etc. Does NOT download the bytes; use 'pane attachment
download' for that.

Options:
  --url <url>            Relay base URL (overrides PANE_URL).
  --api-key <key>        Agent API key (overrides PANE_API_KEY).
  -h, --help             Show this help.

Output (stdout, JSON):
  AttachmentRef`;

export async function runBlobShow(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane attachment show");

  const attachmentId = args.positionals[0];
  if (!attachmentId) {
    fail(
      "missing <attachment-id> — 'pane attachment show <attachment-id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const ref = await client.getBlob(attachmentId!);
    printJson(ref);
  } catch (e) {
    failFromError(e);
  }
}
