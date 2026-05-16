// `pane state <id>` — non-blocking snapshot of a session.

import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

export const stateHelp = `pane state — show a session's metadata and event log

Usage:
  pane state <session-id> [options]

Non-blocking. Fetches session metadata (GET /v1/sessions/:id) plus the event
log (GET /v1/sessions/:id/events) and prints them together.

Options:
  --since <cursor>    Only return events after this opaque cursor.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output (stdout, JSON):
  { meta, events, next_cursor }`;

export async function runState(args: ParsedArgs): Promise<void> {
  const sessionId = args.positionals[0];
  if (!sessionId) fail("missing <session-id>", "invalid_args");

  const since = args.flags.get("since") ?? null;
  const client = makeClient(args);
  try {
    const meta = await client.getSession(sessionId!);
    const page = await client.getEvents(sessionId!, { since });
    printJson({ meta, events: page.events, next_cursor: page.next_cursor });
  } catch (e) {
    failFromError(e);
  }
}
