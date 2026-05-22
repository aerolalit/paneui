// `pane blob token <mint|revoke|list>` — capability URLs for a blob.
//
// A capability URL (/b/<token>) is a participant-facing way to fetch a blob
// without holding the agent's API key. Tokens are minted per-blob, can be
// time-bound (--ttl) and/or single-use (--once), and are stored hashed on
// the relay — the plaintext token is returned ONCE on 'mint' and cannot be
// recovered.
//
// This file is a sub-noun dispatcher under `pane blob`. The blob dispatcher
// hands us a ParsedArgs whose positionals[0] is "token" (our sub-noun
// marker), so we read the verb from positionals[1] and the args from
// positionals[2..]. Mirrors how participant.ts dispatches under `pane
// session participant`.

import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export const blobTokenHelp = `pane blob token — manage a blob's capability URLs

Capability URLs let a participant (or any browser holding the URL) fetch a
blob without the agent's API key. Tokens are stored HASHED on the relay; the
plaintext token is returned only ONCE from 'mint' — save the response before
delivering the URL.

Usage:
  pane blob token <verb> <args>

Verbs:
  mint <blob-id>          Mint a /b/<token> capability URL for one blob.
                          Optional: --ttl <seconds> (defaults by scope:
                          30d artifact / session TTL / 24h agent; the caller
                          can only shorten), --once (token self-deletes on
                          first successful GET). Returns { token, url,
                          expires_at, ... } — ONCE.

  revoke <blob-id> <token-id>
                          Invalidate one previously-minted token by id.
                          Idempotent: revoking twice still returns success.

  list <blob-id>          Enumerate the tokens minted against one blob,
                          including revoked rows (for audit). Returns
                          { blob_id, items: [...] } where each item carries
                          { token_id, token_prefix, expires_at, once,
                          created_at, last_used_at, use_count, revoked_at }.
                          The token plaintext is NEVER returned.

Options:
  --ttl <seconds>         (mint) per-token TTL; clamped by scope default.
  --once                  (mint) token self-deletes on first GET.
  --url <url>             Relay base URL (overrides PANE_URL).
  --api-key <key>         Agent API key (overrides PANE_API_KEY).
  -h, --help              Show this help.

Output: stdout is machine-readable JSON.`;

async function runBlobTokenMint(args: ParsedArgs): Promise<void> {
  const blobId = args.positionals[1];
  if (!blobId) {
    fail(
      "missing <blob-id> — 'pane blob token mint <blob-id>'",
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

async function runBlobTokenRevoke(args: ParsedArgs): Promise<void> {
  const blobId = args.positionals[1];
  const tokenId = args.positionals[2];
  if (!blobId || !tokenId) {
    fail(
      "missing arguments — 'pane blob token revoke <blob-id> <token-id>'",
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

async function runBlobTokenList(args: ParsedArgs): Promise<void> {
  const blobId = args.positionals[1];
  if (!blobId) {
    fail(
      "missing <blob-id> — 'pane blob token list <blob-id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const r = await client.listBlobTokens(blobId!);
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}

export async function runBlobToken(args: ParsedArgs): Promise<void> {
  // positionals[0] is the verb (mint | revoke | list), positionals[1..] are
  // the verb's args. (The blob.ts dispatcher already shifted off the "token"
  // marker before calling us.)
  const verb = args.positionals[0];
  switch (verb) {
    case "mint":
      await runBlobTokenMint(args);
      break;
    case "revoke":
      await runBlobTokenRevoke(args);
      break;
    case "list":
      await runBlobTokenList(args);
      break;
    case undefined:
      fail(
        "missing verb — usage: pane blob token <mint|revoke|list> (run 'pane blob token --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown token verb '${verb}' — expected mint|revoke|list (run 'pane blob token --help')`,
        "invalid_args",
      );
  }
}
