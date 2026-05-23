// `pane blob download <blob-id>` — fetch blob bytes by id.

import { writeFileSync } from "node:fs";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

const KNOWN_FLAGS = ["out"];
const KNOWN_BOOLS: string[] = [];

export const blobDownloadHelp = `pane blob download — fetch a blob's bytes

Usage:
  pane blob download <blob-id> [--out <path>] [options]

GETs the blob bytes. With --out <path> the bytes are written to that file and
a JSON summary is printed on stdout; without --out the bytes are written to
stdout verbatim (useful for piping into another tool — but binary on a TTY
is rarely useful).

Options:
  --out <path>           Write bytes to <path> instead of stdout.
  --url <url>            Relay base URL (overrides PANE_URL).
  --api-key <key>        Agent API key (overrides PANE_API_KEY).
  -h, --help             Show this help.

Output:
  Without --out: raw bytes to stdout.
  With --out:    { blob_id, written: <path>, bytes: <n> } to stdout.`;

export async function runBlobDownload(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane blob download");

  const blobId = args.positionals[0];
  if (!blobId) {
    fail("missing <blob-id> — 'pane blob download <blob-id>'", "invalid_args");
  }
  const out = args.flags.get("out");

  const client = makeClient(args);
  try {
    const buf = await client.downloadBlob(blobId!);
    if (out) {
      writeFileSync(out, Buffer.from(buf));
      printJson({ blob_id: blobId, written: out, bytes: buf.byteLength });
    } else {
      // Binary to stdout — useful for piping into another tool.
      process.stdout.write(Buffer.from(buf));
    }
  } catch (e) {
    failFromError(e);
  }
}
