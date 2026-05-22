// `pane blob list` — enumerate YOUR agent's blobs.
//
// Lists blobs owned by the calling agent, newest first. Soft-deleted blobs
// are excluded; tokens are not enumerated here (use 'pane blob token list
// <blob-id>' for that).

import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, printJson, failFromError } from "../output.js";

export const blobListHelp = `pane blob list — enumerate YOUR agent's blobs

Usage:
  pane blob list [--cursor <token>] [--limit <n>] [options]

Returns the agent's non-deleted blobs (newest first). Paginated via opaque
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
  { items: BlobRef[], next_cursor: string | null }`;

export async function runBlobList(args: ParsedArgs): Promise<void> {
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
