// `pane send <id>` — append an agent event to a session.

import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";

export const sendHelp = `pane send — emit an agent event into a session

Usage:
  pane send <session-id> --type <event-type> --data <path|json> [options]

POSTs an event to /v1/sessions/:id/events. The event is stamped as authored by
the agent (the relay derives identity from the API key — it cannot be spoofed).

Required:
  --type <t>          Event type. Must exist in the session's event schema
                      with the agent in its emittedBy list.
  --data <v>          Event payload: a file path to a .json file, or inline
                      JSON. Use --data 'null' or --data '{}' for no payload.

Options:
  --causation-id <id> Opaque causation id stored verbatim on the event.
  --idempotency-key <k>  Dedup key — a repeat send with the same key is a no-op.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  --json              Output JSON (default).
  -h, --help          Show this help.

Output (stdout, JSON):
  { event, deduped }`;

export async function runSend(args: ParsedArgs): Promise<void> {
  const sessionId = args.positionals[0];
  if (!sessionId) fail("missing <session-id>", "invalid_args");

  const type = args.flags.get("type");
  if (!type) fail("missing --type", "invalid_args");

  const dataRaw = args.flags.get("data");
  if (dataRaw === undefined) fail("missing --data", "invalid_args");

  let data: unknown;
  try {
    data = resolveJson(dataRaw!, "--data");
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "invalid_args");
  }

  const client = makeClient(args);
  try {
    const res = await client.sendEvent(sessionId!, {
      type: type!,
      data,
      causationId: args.flags.get("causation-id"),
      idempotencyKey: args.flags.get("idempotency-key"),
    });
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}
