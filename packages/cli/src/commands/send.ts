// `pane send <id>` — append an agent event to a pane.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";

const KNOWN_FLAGS = [
  "type",
  "data",
  "attachment",
  "causation-id",
  "idempotency-key",
];
const KNOWN_BOOLS: string[] = [];

export const sendHelp = `pane send — emit an agent event into a pane

Usage:
  pane send <pane-id> --type <event-type> --data <path|json> [options]
  pane send <pane-id> --type <event-type> --attachment <file-path> [options]

POSTs an event to /v1/panes/:id/events. The event is stamped as authored by
the agent (the relay derives identity from the API key — it cannot be spoofed).

Required:
  --type <t>          Event type. Must exist in the pane's event schema
                      with the agent in its emittedBy list.
  --data <v>          Event payload: a file path to a .json file, or inline
                      JSON. Use --data 'null' or --data '{}' for no payload.

  ALTERNATIVE to --data:
  --attachment <path>       One-shot: upload <path> as a pane-scope attachment, then
                      send an event whose payload is the AttachmentRef. The event
                      data is { attachment: <AttachmentRef> }; declare it in your event
                      schema with \`format: pane-attachment-id\` on \`attachment.attachment_id\`.

Options:
  --causation-id <id> Opaque causation id stored verbatim on the event.
  --idempotency-key <k>  Dedup key — a repeat send with the same key is a no-op.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output (stdout, JSON):
  { event, deduped }`;

export async function runSend(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane send");

  const paneId = args.positionals[0];
  if (!paneId) fail("missing <pane-id>", "invalid_args");

  const type = args.flags.get("type");
  if (!type) fail("missing --type", "invalid_args");

  const dataRaw = args.flags.get("data");
  const blobPath = args.flags.get("attachment");

  if (dataRaw !== undefined && blobPath !== undefined) {
    fail("--data and --attachment are mutually exclusive", "invalid_args");
  }
  if (dataRaw === undefined && blobPath === undefined) {
    fail("missing --data or --attachment", "invalid_args");
  }

  const client = makeClient(args);

  // --attachment path: upload the file as a pane-scope attachment, then send an
  // event whose data is { attachment: <AttachmentRef> }. The pane's event schema
  // is expected to declare a attachment field with format: pane-attachment-id.
  if (blobPath !== undefined) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(blobPath);
    } catch (e) {
      fail(
        `failed to read --attachment '${blobPath}': ${e instanceof Error ? e.message : String(e)}`,
        "invalid_args",
      );
    }
    try {
      const ref = await client.uploadBlob(bytes, {
        scope: "pane",
        paneId: paneId!,
        filename: basename(blobPath),
      });
      const res = await client.sendEvent(paneId!, {
        type: type!,
        data: { attachment: ref },
        causationId: args.flags.get("causation-id"),
        idempotencyKey: args.flags.get("idempotency-key"),
      });
      printJson(res);
    } catch (e) {
      failFromError(e);
    }
    return;
  }

  let data: unknown;
  try {
    data = resolveJson(dataRaw!, "--data");
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "invalid_args");
  }

  try {
    const res = await client.sendEvent(paneId!, {
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
