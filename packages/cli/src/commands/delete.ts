// `pane session delete <id>` — close/delete a session.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

const KNOWN_FLAGS: string[] = [];
const KNOWN_BOOLS: string[] = [];

export const deleteHelp = `pane session delete — close/delete a session

Usage:
  pane session delete <session-id> [options]

Closes and deletes the session (DELETE /v1/sessions/:id). Idempotent on the
relay side — deleting an already-closed session still succeeds.

Options:
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output (stdout, JSON):
  { session_id, deleted: true }`;

export async function runDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane session delete");

  const sessionId = args.positionals[0];
  if (!sessionId) fail("missing <session-id>", "invalid_args");

  const client = makeClient(args);
  try {
    await client.deleteSession(sessionId!);
    printJson({ session_id: sessionId, deleted: true });
  } catch (e) {
    failFromError(e);
  }
}
