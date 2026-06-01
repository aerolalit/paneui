// `pane attachment` — manage binary attachments (attachments) on the relay.
//
// A attachment is a typed binary file (image, PDF, audio, video, etc.) owned by an
// agent and optionally bound to a pane or template. Pages reference attachments
// by id with `format: pane-attachment-id`; participants can fetch a attachment through a
// minted capability URL (/b/<token>) without needing the agent's API key.
//
// This file is a thin dispatcher — each verb's actual logic lives in its own
// file (attachment-upload.ts, attachment-download.ts, attachment-show.ts, attachment-delete.ts) and
// the token sub-noun is dispatched via attachment-token.ts.
//
// Most attachment verbs read their primary positional (the attachment_id) at
// positionals[0]; we slice off our own verb before delegating so each verb
// runner doesn't need to know it was reached through `pane attachment`.

import type { ParsedArgs } from "../argv.js";
import { runBlobUpload, blobUploadHelp } from "./attachment-upload.js";
import { runBlobDownload, blobDownloadHelp } from "./attachment-download.js";
import { runBlobShow, blobShowHelp } from "./attachment-show.js";
import { runBlobList, blobListHelp } from "./attachment-list.js";
import { runBlobDelete, blobDeleteHelp } from "./attachment-delete.js";
import { runBlobToken, blobTokenHelp } from "./attachment-token.js";
import { fail } from "../output.js";

export const blobHelp = `pane attachment — manage attachments (binary attachments) on the relay

A attachment is a typed binary file (image, PDF, audio, video, ...) the agent has
uploaded to the relay. Blobs are scoped:

  agent     — reusable across the agent's panes (default)
  pane   — bound to one pane; deleted with it
  template  — bound to a reusable template; deleted with it

Pages reference attachments by id (the relay's schema validates the id with
\`format: pane-attachment-id\`). For a participant-facing URL that bypasses the
agent's API key, mint a token with 'pane attachment token mint'.

Usage:
  pane attachment <verb> [options]

Verbs:
  upload                 Upload a local file. Required: --file. Optional:
                         --scope, --pane-id, --template-id, --filename,
                         --mime. Prints { attachment_id, scope, mime, size, sha256,
                         ... }.

  download <attachment-id>     Download a attachment by id. Use --out <path> to write a
                         file (default: writes to stdout — useful for piping).

  show <attachment-id>         Print a attachment's metadata (HEAD-based — doesn't
                         download the bytes).

  list                   Enumerate YOUR agent's non-deleted attachments (newest
                         first). Supports --cursor + --limit for pagination.

  delete <attachment-id>       Soft-delete a attachment. Idempotent.

  token <verb>           Capability URLs for a attachment (mint | revoke | list).
                         'mint' returns a /b/<token> URL anyone can GET, with
                         optional --ttl and --once. 'revoke' invalidates one
                         token. 'list' enumerates a attachment's tokens (without
                         the token plaintext, which is unrecoverable).

Run \`pane attachment <verb> --help\` for verb-specific options.

Output: stdout is machine-readable JSON. Errors go to stderr as
{"error":{"code","message"}} with a non-zero exit.`;

/**
 * Build a new ParsedArgs with the leading positional (the verb) stripped.
 * The downstream verb runners read their primary positional (the attachment_id)
 * at positionals[0], so we hand them an args object that looks exactly like
 * they were called directly — mirrors pane.ts's shiftPositionals.
 */
function shiftPositionals(args: ParsedArgs): ParsedArgs {
  // Propagate danglingValueFlags so the leaf runner's assertKnownFlags
  // can still distinguish "unknown flag" from "missing value" — see the
  // matching note in pane.ts's shiftPositionals.
  const out: ParsedArgs = {
    positionals: args.positionals.slice(1),
    flags: args.flags,
    bools: args.bools,
  };
  if (args.danglingValueFlags !== undefined) {
    out.danglingValueFlags = args.danglingValueFlags;
  }
  return out;
}

export async function runBlob(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];

  // `pane attachment token --help` (verb-level help on the token sub-noun, with no
  // further sub-verb). The general --help pre-empt in index.ts only fires
  // when no positional follows the noun; here a positional ("token") is
  // present, so the sub-noun must own its own --help routing.
  if (
    verb === "token" &&
    args.bools.has("help") &&
    args.positionals.length === 1
  ) {
    process.stdout.write(blobTokenHelp + "\n");
    return;
  }
  // `pane attachment list --help` — same pattern (list takes no required positional
  // so the general pre-empt would already fire, but for parity with pane.ts
  // we route through here when args carry the "list" positional explicitly).
  if (
    verb === "list" &&
    args.bools.has("help") &&
    args.positionals.length === 1
  ) {
    process.stdout.write(blobListHelp + "\n");
    return;
  }

  const inner = shiftPositionals(args);
  switch (verb) {
    case "upload":
      await runBlobUpload(inner);
      break;
    case "download":
      await runBlobDownload(inner);
      break;
    case "show":
      await runBlobShow(inner);
      break;
    case "list":
      await runBlobList(inner);
      break;
    case "delete":
      await runBlobDelete(inner);
      break;
    case "token":
      await runBlobToken(inner);
      break;
    case undefined:
      fail(
        "missing verb — usage: pane attachment <upload|download|show|list|delete|token> (run 'pane attachment --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown attachment verb '${verb}' — expected upload|download|show|list|delete|token (run 'pane attachment --help')`,
        "invalid_args",
      );
  }
}

// Re-export per-verb helps so tests / docs can import them by canonical name
// without knowing which file owns each verb.
export {
  blobUploadHelp,
  blobDownloadHelp,
  blobShowHelp,
  blobListHelp,
  blobDeleteHelp,
  blobTokenHelp,
};
