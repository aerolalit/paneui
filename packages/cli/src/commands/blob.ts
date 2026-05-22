// `pane blob` — manage binary attachments (blobs) on the relay.
//
// A blob is a typed binary file (image, PDF, audio, video, etc.) owned by an
// agent and optionally bound to a session or artifact. Pages reference blobs
// by id with `format: pane-blob-id`; participants can fetch a blob through a
// minted capability URL (/b/<token>) without needing the agent's API key.
//
// This file is a thin dispatcher — each verb's actual logic lives in its own
// file (blob-upload.ts, blob-download.ts, blob-show.ts, blob-delete.ts) and
// the token sub-noun is dispatched via blob-token.ts.
//
// Most blob verbs read their primary positional (the blob_id) at
// positionals[0]; we slice off our own verb before delegating so each verb
// runner doesn't need to know it was reached through `pane blob`.

import type { ParsedArgs } from "../argv.js";
import { runBlobUpload, blobUploadHelp } from "./blob-upload.js";
import { runBlobDownload, blobDownloadHelp } from "./blob-download.js";
import { runBlobShow, blobShowHelp } from "./blob-show.js";
import { runBlobDelete, blobDeleteHelp } from "./blob-delete.js";
import { runBlobToken, blobTokenHelp } from "./blob-token.js";
import { fail } from "../output.js";

export const blobHelp = `pane blob — manage blobs (binary attachments) on the relay

A blob is a typed binary file (image, PDF, audio, video, ...) the agent has
uploaded to the relay. Blobs are scoped:

  agent     — reusable across the agent's sessions (default)
  session   — bound to one session; deleted with it
  artifact  — bound to a reusable artifact; deleted with it

Pages reference blobs by id (the relay's schema validates the id with
\`format: pane-blob-id\`). For a participant-facing URL that bypasses the
agent's API key, mint a token with 'pane blob token mint'.

Usage:
  pane blob <verb> [options]

Verbs:
  upload                 Upload a local file. Required: --file. Optional:
                         --scope, --session-id, --artifact-id, --filename,
                         --mime. Prints { blob_id, scope, mime, size, sha256,
                         ... }.

  download <blob-id>     Download a blob by id. Use --out <path> to write a
                         file (default: writes to stdout — useful for piping).

  show <blob-id>         Print a blob's metadata (HEAD-based — doesn't
                         download the bytes).

  delete <blob-id>       Soft-delete a blob. Idempotent.

  token <verb>           Capability URLs for a blob (mint | revoke). 'mint'
                         returns a /b/<token> URL anyone can GET, with
                         optional --ttl and --once. 'revoke' invalidates one
                         token.

Run \`pane blob <verb> --help\` for verb-specific options.

Output: stdout is machine-readable JSON. Errors go to stderr as
{"error":{"code","message"}} with a non-zero exit.`;

/**
 * Build a new ParsedArgs with the leading positional (the verb) stripped.
 * The downstream verb runners read their primary positional (the blob_id)
 * at positionals[0], so we hand them an args object that looks exactly like
 * they were called directly — mirrors session.ts's shiftPositionals.
 */
function shiftPositionals(args: ParsedArgs): ParsedArgs {
  return {
    positionals: args.positionals.slice(1),
    flags: args.flags,
    bools: args.bools,
  };
}

export async function runBlob(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];

  // `pane blob token --help` (verb-level help on the token sub-noun, with no
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
    case "delete":
      await runBlobDelete(inner);
      break;
    case "token":
      await runBlobToken(inner);
      break;
    case undefined:
      fail(
        "missing verb — usage: pane blob <upload|download|show|delete|token> (run 'pane blob --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown blob verb '${verb}' — expected upload|download|show|delete|token (run 'pane blob --help')`,
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
  blobDeleteHelp,
  blobTokenHelp,
};
