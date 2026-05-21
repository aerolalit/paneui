// `pane list` — enumerate YOUR agent's sessions.
//
// The recovery primitive when the create-response was dropped: the URL itself
// is unrecoverable (the relay stores only the token hash), but every other
// field of the session is intact and listable here. Pair with
// `pane participant new` to mint a fresh URL on a session whose original was
// lost.

import type { ListSessionsStatus } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

export const listHelp = `pane list — list YOUR agent's sessions

Prints sessions (newest first) with no secrets in the response. Participant
tokens are stored hashed and CANNOT be recovered — if you lost a session URL,
mint a fresh one with 'pane participant new <session-id>'.

Usage:
  pane list [options]

Options:
  --status <s>      open | closed | all. Default: open. The status reported
                    is the EFFECTIVE status — a row whose ttl is in the past
                    is reported as 'closed' even if not yet swept.
  --limit <N>       Page size (default 50, max 200).
  --cursor <c>      Opaque cursor from a previous page's next_cursor.
  --artifact-id <i> Filter to sessions instantiated from a specific named
                    artifact (head id; not version id). Inline (anonymous)
                    artifacts cannot be filtered this way — they have no
                    stable handle.
  --url <url>       Relay base URL (overrides PANE_URL).
  --api-key <key>   Agent API key (overrides PANE_API_KEY).
  -h, --help        Show this help.

Recovery recipe (lost the URL but the session is still alive):
  pane list                                       # find the session_id and
                                                  #   participant_id you lost
  pane participant new <session-id>               # mint a fresh URL —
                                                  #   the old one is still
                                                  #   valid until you revoke
  pane participant revoke <session-id> <p-id>     # invalidate the old URL

Output (stdout, JSON):
  {
    items: [
      {
        session_id, title, status, artifact_id, artifact_version_id,
        artifact_version, participants: [...], created_at, expires_at,
        has_callback
      },
      ...
    ],
    next_cursor: <opaque|null>
  }`;

const STATUSES: readonly ListSessionsStatus[] = ["open", "closed", "all"];

export async function runList(args: ParsedArgs): Promise<void> {
  const opts: {
    status?: ListSessionsStatus;
    limit?: number;
    cursor?: string;
    artifact_id?: string;
  } = {};

  const status = args.flags.get("status");
  if (status !== undefined) {
    if (!STATUSES.includes(status as ListSessionsStatus)) {
      fail(
        `--status must be one of: ${STATUSES.join(", ")} (got '${status}')`,
        "invalid_args",
      );
    }
    opts.status = status as ListSessionsStatus;
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

  const artifactId = args.flags.get("artifact-id");
  if (artifactId !== undefined && artifactId !== "") {
    opts.artifact_id = artifactId;
  }

  const client = makeClient(args);
  try {
    const page = await client.listSessions(opts);
    printJson(page);
  } catch (e) {
    failFromError(e);
  }
}
