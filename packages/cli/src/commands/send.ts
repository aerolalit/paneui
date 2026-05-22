// `pane send <id>` — append an agent event to a session.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";

export const sendHelp = `pane send — emit an agent event into a session

Usage:
  pane send <session-id> --type <event-type> --data <path|json> [options]
  pane send <session-id> --type <event-type> --blob <file-path> [options]

POSTs an event to /v1/sessions/:id/events. The event is stamped as authored by
the agent (the relay derives identity from the API key — it cannot be spoofed).

Required:
  --type <t>          Event type. Must exist in the session's event schema
                      with the agent in its emittedBy list.
  --data <v>          Event payload: a file path to a .json file, or inline
                      JSON. Use --data 'null' or --data '{}' for no payload.

  ALTERNATIVE to --data:
  --blob <path>       One-shot: upload <path> as a session-scope blob, then
                      send an event whose payload is the BlobRef. The event
                      data is { blob: <BlobRef> }; declare it in your event
                      schema with \`format: pane-blob-id\` on \`blob.blob_id\`.

Options:
  --causation-id <id> Opaque causation id stored verbatim on the event.
  --idempotency-key <k>  Dedup key — a repeat send with the same key is a no-op.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output (stdout, JSON):
  { event, deduped }`;

export async function runSend(args: ParsedArgs): Promise<void> {
  const sessionId = args.positionals[0];
  if (!sessionId) fail("missing <session-id>", "invalid_args");

  const type = args.flags.get("type");
  if (!type) fail("missing --type", "invalid_args");

  const dataRaw = args.flags.get("data");
  const blobPath = args.flags.get("blob");

  if (dataRaw !== undefined && blobPath !== undefined) {
    fail("--data and --blob are mutually exclusive", "invalid_args");
  }
  if (dataRaw === undefined && blobPath === undefined) {
    fail("missing --data or --blob", "invalid_args");
  }

  const client = makeClient(args);

  // --blob path: upload the file as a session-scope blob, then send an
  // event whose data is { blob: <BlobRef> }. The session's event schema
  // is expected to declare a blob field with format: pane-blob-id.
  if (blobPath !== undefined) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(blobPath);
    } catch (e) {
      fail(
        `failed to read --blob '${blobPath}': ${e instanceof Error ? e.message : String(e)}`,
        "invalid_args",
      );
    }
    try {
      const ref = await client.uploadBlob(bytes, {
        scope: "session",
        sessionId: sessionId!,
        filename: basename(blobPath),
      });
      const res = await client.sendEvent(sessionId!, {
        type: type!,
        data: { blob: ref },
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
