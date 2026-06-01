// `pane list` — enumerate YOUR agent's panes.
//
// The recovery primitive when the create-response was dropped: the URL itself
// is unrecoverable (the relay stores only the token hash), but every other
// field of the pane is intact and listable here. Pair with
// `pane participant new` to mint a fresh URL on a pane whose
// original was lost.

import type { ListPanesStatus } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

const KNOWN_FLAGS = ["status", "limit", "cursor", "template-id"];
const KNOWN_BOOLS: string[] = [];

export const listHelp = `pane list — list YOUR agent's panes

Prints panes (newest first) with no secrets in the response. Participant
tokens are stored hashed and CANNOT be recovered — if you lost a pane URL,
mint a fresh one with 'pane participant new <pane-id>'.

Usage:
  pane list [options]

Options:
  --status <s>      open | closed | all. Default: open. The status reported
                    is the EFFECTIVE status — a row whose ttl is in the past
                    is reported as 'closed' even if not yet swept.
  --limit <N>       Page size (default 50, max 200).
  --cursor <c>      Opaque cursor from a previous page's next_cursor.
  --template-id <i> Filter to panes instantiated from a specific named
                    template (head id; not version id). Inline (anonymous)
                    templates cannot be filtered this way — they have no
                    stable handle.
  --url <url>       Relay base URL (overrides PANE_URL).
  --api-key <key>   Agent API key (overrides PANE_API_KEY).
  -h, --help        Show this help.

Recovery recipe (lost the URL but the pane is still alive):
  pane list                                       # find the
                                                          #   pane_id +
                                                          #   participant_id
                                                          #   you lost
  pane participant new <pane-id>               # mint a fresh URL
  pane participant revoke <pane-id> <p-id>     # invalidate the
                                                          #   old URL

Output (stdout, JSON):
  {
    items: [
      {
        pane_id, title, status, template_id, template_version_id,
        template_version, participants: [...], created_at, expires_at,
        has_callback
      },
      ...
    ],
    next_cursor: <opaque|null>
  }`;

const STATUSES: readonly ListPanesStatus[] = ["open", "closed", "all"];

export async function runList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane list");

  const opts: {
    status?: ListPanesStatus;
    limit?: number;
    cursor?: string;
    template_id?: string;
  } = {};

  const status = args.flags.get("status");
  if (status !== undefined) {
    if (!STATUSES.includes(status as ListPanesStatus)) {
      fail(
        `--status must be one of: ${STATUSES.join(", ")} (got '${status}')`,
        "invalid_args",
      );
    }
    opts.status = status as ListPanesStatus;
  }

  const limitRaw = args.flags.get("limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0 || n > 200) {
      fail(
        `--limit must be an integer in 1..200 (got '${limitRaw}')`,
        "invalid_args",
      );
    }
    opts.limit = n;
  }

  const cursor = args.flags.get("cursor");
  if (cursor !== undefined && cursor !== "") opts.cursor = cursor;

  const templateId = args.flags.get("template-id");
  if (templateId !== undefined && templateId !== "") {
    opts.template_id = templateId;
  }

  const client = makeClient(args);
  try {
    const page = await client.listPanes(opts);
    printJson(page);
  } catch (e) {
    failFromError(e);
  }
}
