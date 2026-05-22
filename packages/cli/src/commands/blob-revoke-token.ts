// `pane blob revoke-token <blob-id> <token-id>` — invalidate one token.

import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export const blobRevokeTokenHelp = `pane blob revoke-token — invalidate a capability token

Usage:
  pane blob revoke-token <blob-id> <token-id> [options]

DELETEs /v1/blobs/:id/tokens/:token_id. Idempotent — revoking an already-
revoked token still returns success.

Options:
  --url <url>            Relay base URL (overrides PANE_URL).
  --api-key <key>        Agent API key (overrides PANE_API_KEY).
  -h, --help             Show this help.

Output (stdout, JSON):
  { blob_id, token_id, revoked: true }`;

export async function runBlobRevokeToken(args: ParsedArgs): Promise<void> {
  const blobId = args.positionals[0];
  const tokenId = args.positionals[1];
  if (!blobId || !tokenId) {
    fail(
      "missing arguments — 'pane blob revoke-token <blob-id> <token-id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const r = await client.revokeBlobToken(blobId!, tokenId!);
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}
