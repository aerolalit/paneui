// `pane surface delete <id>` — close/delete a surface.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

const KNOWN_FLAGS: string[] = [];
const KNOWN_BOOLS: string[] = [];

export const deleteHelp = `pane surface delete — close/delete a surface

Usage:
  pane surface delete <surface-id> [options]

Closes and deletes the surface (DELETE /v1/surfaces/:id). Idempotent on the
relay side — deleting an already-closed surface still succeeds.

Options:
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output (stdout, JSON):
  { surface_id, deleted: true }`;

export async function runDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane surface delete");

  const surfaceId = args.positionals[0];
  if (!surfaceId) fail("missing <surface-id>", "invalid_args");

  const client = makeClient(args);
  try {
    await client.deleteSession(surfaceId!);
    printJson({ surface_id: surfaceId, deleted: true });
  } catch (e) {
    failFromError(e);
  }
}
