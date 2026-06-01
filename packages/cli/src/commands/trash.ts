// `pane trash <verb>` — manage the soft-delete trash (#306 / CLI follow-up).
//
//   pane trash list                              show soft-deleted panes + templates
//   pane trash restore <pane-id>                 restore a trashed pane
//   pane trash restore-template <template-id>    restore a trashed template
//   pane trash purge <pane-id>                   permanent hard-delete now
//   pane trash purge-template <template-id>     permanent hard-delete now
//
// Why "purge" not "delete": `pane delete <id>` already exists and means
// "close the live pane" (which, with #303, sends it to trash via the TTL
// sweeper after it expires). Using "delete" again on a trashed row would
// be confusing — "purge" reads unambiguously as "the row is gone for good".

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

const KNOWN_FLAGS: string[] = [];
const KNOWN_BOOLS: string[] = [];

export const trashHelp = `pane trash — manage the soft-delete trash

Usage:
  pane trash list                            Show soft-deleted panes + templates
  pane trash restore <pane-id>               Restore a trashed pane
  pane trash restore-template <id-or-slug>   Restore a trashed template
  pane trash purge <pane-id>                 Permanent hard-delete now (skips
                                             the retention window)
  pane trash purge-template <id-or-slug>     Permanent hard-delete now

Soft-deleted rows live in trash until the hard-delete sweeper reclaims them
(default retention: 30 days free / never paid). 'restore' takes them back
out of trash; 'purge' deletes them immediately, bypassing the window.

Options:
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output (stdout, JSON):
  list:               { panes: [...], templates: [...] }
  restore / purge:    { pane_id|template_id, restored|purged: true }`;

export async function runTrash(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane trash");

  const verb = args.positionals[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stdout.write(trashHelp + "\n");
    return;
  }

  const id = args.positionals[1];

  // Validate positional arguments BEFORE building the client so the
  // invalid_args envelope is emitted without a second wrap-around via
  // failFromError (which would clobber it to `internal`).
  switch (verb) {
    case "list":
    case "restore":
    case "restore-template":
    case "purge":
    case "purge-template":
      break;
    default:
      fail(
        `unknown trash verb '${verb}' — run 'pane trash --help'`,
        "invalid_args",
      );
  }
  if (verb === "restore" || verb === "purge") {
    if (!id) fail("missing <pane-id>", "invalid_args");
  } else if (verb === "restore-template" || verb === "purge-template") {
    if (!id) fail("missing <template-id-or-slug>", "invalid_args");
  }

  const client = makeClient(args);
  try {
    switch (verb) {
      case "list": {
        const body = await client.listTrash();
        printJson(body);
        return;
      }
      case "restore": {
        await client.restorePane(id!);
        printJson({ pane_id: id, restored: true });
        return;
      }
      case "restore-template": {
        await client.restoreTemplate(id!);
        printJson({ template_id: id, restored: true });
        return;
      }
      case "purge": {
        await client.permanentDeletePane(id!);
        printJson({ pane_id: id, purged: true });
        return;
      }
      case "purge-template": {
        await client.permanentDeleteTemplate(id!);
        printJson({ template_id: id, purged: true });
        return;
      }
    }
  } catch (e) {
    failFromError(e);
  }
}
