// `pane attachment list` — enumerate YOUR agent's attachments.
//
// Lists attachments owned by the calling agent, newest first. Soft-deleted attachments
// are excluded; tokens are not enumerated here (use 'pane attachment token list
// <attachment-id>' for that).

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, printJson, failFromError } from "../output.js";

const KNOWN_FLAGS = ["cursor", "limit"];
const KNOWN_BOOLS: string[] = [];

export const blobListHelp = `pane attachment list — enumerate YOUR agent's attachments

Usage:
  pane attachment list [--cursor <token>] [--limit <n>] [options]

Returns the agent's non-deleted attachments (newest first). Paginated via opaque
cursor: when next_cursor is non-null in the response, pass it back as
--cursor to get the next page.

Options:
  --cursor <token>       Opaque pagination cursor from a prior response.
  --limit <n>            Page size (1..100). Defaults to the relay default
                         (50).
  --url <url>            Relay base URL (overrides PANE_URL).
  --api-key <key>        Agent API key (overrides PANE_API_KEY).
  -h, --help             Show this help.

Output (stdout, JSON):
  { items: AttachmentRef[], next_cursor: string | null }`;

export async function runBlobList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane attachment list");

  const cursor = args.flags.get("cursor");
  const limitRaw = args.flags.get("limit");
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      fail("--limit must be an integer in 1..100", "invalid_args");
    }
    limit = n;
  }
  const client = makeClient(args);
  try {
    const r = await client.listBlobs({ cursor, limit });
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}
