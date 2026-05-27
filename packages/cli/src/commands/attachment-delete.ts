// `pane attachment delete <attachment-id>` — soft-delete a attachment.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

const KNOWN_FLAGS: string[] = [];
const KNOWN_BOOLS: string[] = [];

export const blobDeleteHelp = `pane attachment delete — soft-delete a attachment

Usage:
  pane attachment delete <attachment-id> [options]

Marks the attachment as deleted (DELETE /v1/attachments/:id). Idempotent: deleting an
already-deleted attachment still returns success. Tokens minted against this attachment
become unusable.

Options:
  --url <url>            Relay base URL (overrides PANE_URL).
  --api-key <key>        Agent API key (overrides PANE_API_KEY).
  -h, --help             Show this help.

Output (stdout, JSON):
  { attachment_id, deleted: true }`;

export async function runBlobDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane attachment delete");

  const attachmentId = args.positionals[0];
  if (!attachmentId) {
    fail(
      "missing <attachment-id> — 'pane attachment delete <attachment-id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const r = await client.deleteBlob(attachmentId!);
    printJson({ attachment_id: attachmentId, ...r });
  } catch (e) {
    failFromError(e);
  }
}
