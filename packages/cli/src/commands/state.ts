// `pane session show <id>` — snapshot of a session, optionally long-polled.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

const KNOWN_FLAGS = ["since", "wait"];
const KNOWN_BOOLS: string[] = [];

export const stateHelp = `pane session show — show a session's metadata and event log

Usage:
  pane session show <session-id> [options]

By default non-blocking: fetches session metadata (GET /v1/sessions/:id) plus
the event log (GET /v1/sessions/:id/events) and prints them together.

With --wait, blocks at the relay for up to <secs> if no new events are
available since the cursor — returns as soon as something lands. Use this
for headless polling agents that can't keep a WebSocket open (cron,
FaaS, slow links): poll, then re-poll using next_cursor as --since on the
next call. Compared to 'pane session watch', it's higher latency per
round-trip but no long-lived connection.

Options:
  --since <cursor>    Only return events after this opaque cursor. Pass
                      next_cursor from the previous call to chain pages.
  --wait <secs>       Long-poll window. The relay holds the request open
                      for up to this many seconds, capped server-side at
                      30. Without --since, this still returns immediately
                      with whatever events exist — long-poll only blocks
                      when there are NO new events to return.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output (stdout, JSON):
  { meta, events, next_cursor }`;

export async function runState(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane session show");

  const sessionId = args.positionals[0];
  if (!sessionId) fail("missing <session-id>", "invalid_args");

  const since = args.flags.get("since") ?? null;

  // --wait <secs>: hand the server the long-poll window. The relay caps
  // this at 30s; we pass the raw value and let the relay clamp (sending
  // a higher number is not an error, just a clamp). 0 or unset means
  // non-blocking — the default snapshot behaviour.
  let waitSeconds: number | undefined;
  const waitRaw = args.flags.get("wait");
  if (waitRaw !== undefined) {
    const n = Number(waitRaw);
    if (!Number.isFinite(n) || n < 0) {
      fail("--wait must be a non-negative number of seconds", "invalid_args");
    }
    waitSeconds = n;
  }

  const client = makeClient(args);
  try {
    const meta = await client.getSession(sessionId!);
    const page = await client.getEvents(sessionId!, {
      since,
      ...(waitSeconds !== undefined ? { waitSeconds } : {}),
    });
    printJson({ meta, events: page.events, next_cursor: page.next_cursor });
  } catch (e) {
    failFromError(e);
  }
}
