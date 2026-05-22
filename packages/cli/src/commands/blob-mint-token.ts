// `pane blob mint-token <blob-id>` — mint a /b/<token> capability URL.

import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export const blobMintTokenHelp = `pane blob mint-token — mint a capability URL for a blob

Usage:
  pane blob mint-token <blob-id> [--ttl <seconds>] [--once] [options]

POSTs to /v1/blobs/:id/tokens and returns a /b/<token> URL anyone can GET
without the agent's API key. The token plaintext is returned ONCE — save the
response before delivering the URL.

Options:
  --ttl <seconds>        Per-token TTL; defaults by scope (30d artifact /
                         session TTL / 24h agent). The caller can only
                         shorten the default, not extend it.
  --once                 Token self-deletes on first successful GET.
  --url <url>            Relay base URL (overrides PANE_URL).
  --api-key <key>        Agent API key (overrides PANE_API_KEY).
  -h, --help             Show this help.

Output (stdout, JSON):
  { token, url, expires_at, once, ... }`;

export async function runBlobMintToken(args: ParsedArgs): Promise<void> {
  const blobId = args.positionals[0];
  if (!blobId) {
    fail(
      "missing <blob-id> — 'pane blob mint-token <blob-id>'",
      "invalid_args",
    );
  }
  const ttlRaw = args.flags.get("ttl");
  const ttl = ttlRaw === undefined ? undefined : Number(ttlRaw);
  if (ttlRaw !== undefined && (!Number.isInteger(ttl) || ttl! <= 0)) {
    fail("--ttl must be a positive integer (seconds)", "invalid_args");
  }
  const client = makeClient(args);
  try {
    const r = await client.mintBlobToken(blobId!, {
      ttlSeconds: ttl,
      once: args.bools.has("once"),
    });
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}
