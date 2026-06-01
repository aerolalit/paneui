// `pane delete <id>` — close/delete a pane.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

const KNOWN_FLAGS: string[] = [];
const KNOWN_BOOLS: string[] = [];

export const deleteHelp = `pane delete — close/delete a pane

Usage:
  pane delete <pane-id> [options]

Closes and deletes the pane (DELETE /v1/panes/:id). Idempotent on the
relay side — deleting an already-closed pane still succeeds.

Options:
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output (stdout, JSON):
  { pane_id, deleted: true }`;

export async function runDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane delete");

  const paneId = args.positionals[0];
  if (!paneId) fail("missing <pane-id>", "invalid_args");

  const client = makeClient(args);
  try {
    await client.deletePane(paneId!);
    printJson({ pane_id: paneId, deleted: true });
  } catch (e) {
    failFromError(e);
  }
}
