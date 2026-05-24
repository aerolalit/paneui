// `pane attachment token <mint|revoke|list>` — capability URLs for a attachment.
//
// A capability URL (/b/<token>) is a participant-facing way to fetch a attachment
// without holding the agent's API key. Tokens are minted per-attachment, can be
// time-bound (--ttl) and/or single-use (--once), and are stored hashed on
// the relay — the plaintext token is returned ONCE on 'mint' and cannot be
// recovered.
//
// This file is a sub-noun dispatcher under `pane attachment`. The attachment dispatcher
// hands us a ParsedArgs whose positionals[0] is "token" (our sub-noun
// marker), so we read the verb from positionals[1] and the args from
// positionals[2..]. Mirrors how participant.ts dispatches under `pane
// surface participant`.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

const MINT_FLAGS = ["ttl"];
const MINT_BOOLS = ["once"];
const NO_FLAGS: string[] = [];
const NO_BOOLS: string[] = [];

export const blobTokenHelp = `pane attachment token — manage a attachment's capability URLs

Capability URLs let a participant (or any browser holding the URL) fetch a
attachment without the agent's API key. Tokens are stored HASHED on the relay; the
plaintext token is returned only ONCE from 'mint' — save the response before
delivering the URL.

Usage:
  pane attachment token <verb> <args>

Verbs:
  mint <attachment-id>          Mint a /b/<token> capability URL for one attachment.
                          Optional: --ttl <seconds> (defaults by scope:
                          30d template / surface TTL / 24h agent; the caller
                          can only shorten), --once (token self-deletes on
                          first successful GET). Returns { token, url,
                          expires_at, ... } — ONCE.

  revoke <attachment-id> <token-id>
                          Invalidate one previously-minted token by id.
                          Idempotent: revoking twice still returns success.

  list <attachment-id>          Enumerate the tokens minted against one attachment,
                          including revoked rows (for audit). Returns
                          { attachment_id, items: [...] } where each item carries
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
  assertKnownFlags(args, MINT_FLAGS, MINT_BOOLS, "pane attachment token mint");

  const attachmentId = args.positionals[1];
  if (!attachmentId) {
    fail(
      "missing <attachment-id> — 'pane attachment token mint <attachment-id>'",
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
    const r = await client.mintBlobToken(attachmentId!, {
      ttlSeconds: ttl,
      once: args.bools.has("once"),
    });
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}

async function runBlobTokenRevoke(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, NO_BOOLS, "pane attachment token revoke");

  const attachmentId = args.positionals[1];
  const tokenId = args.positionals[2];
  if (!attachmentId || !tokenId) {
    fail(
      "missing arguments — 'pane attachment token revoke <attachment-id> <token-id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const r = await client.revokeBlobToken(attachmentId!, tokenId!);
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}

async function runBlobTokenList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, NO_BOOLS, "pane attachment token list");

  const attachmentId = args.positionals[1];
  if (!attachmentId) {
    fail(
      "missing <attachment-id> — 'pane attachment token list <attachment-id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const r = await client.listBlobTokens(attachmentId!);
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}

export async function runBlobToken(args: ParsedArgs): Promise<void> {
  // positionals[0] is the verb (mint | revoke | list), positionals[1..] are
  // the verb's args. (The attachment.ts dispatcher already shifted off the "token"
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
        "missing verb — usage: pane attachment token <mint|revoke|list> (run 'pane attachment token --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown token verb '${verb}' — expected mint|revoke|list (run 'pane attachment token --help')`,
        "invalid_args",
      );
  }
}
