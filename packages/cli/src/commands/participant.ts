// `pane participant <new|revoke>` — mint or invalidate one
// participant URL on an existing pane. Recovery + leak-containment
// primitives that together replace the destructive `pane delete +
// pane create` workaround for the lost-URL case.
//
// This file is a sub-noun dispatcher under `pane pane`. The pane
// dispatcher hands us a ParsedArgs whose positionals[0] is "participant"
// (our sub-noun marker), so we read the verb from positionals[1] and the
// args from positionals[2..]. This mirrors the way every other sub-verb
// runner (runState, runDelete, ...) reads positionals[0] as its first arg
// after a single shift.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

const NO_FLAGS: string[] = [];
const NO_BOOLS: string[] = [];

export const participantHelp = `pane participant — manage one pane's participant URLs

Participant tokens are stored hashed on the relay and CANNOT be recovered.
If you lost the create-response (and the URL with it), use 'new' to mint a
fresh URL — the pane keeps its event log, template pin, and created_at.
Use 'revoke' to invalidate a single URL while keeping the pane alive.

Usage:
  pane participant <verb> <args>

Verbs:
  list <pane-id>           List the participants on one pane, including
                              revoked rows (for audit). Returns
                              { pane_id, items: [...] } where each item
                              carries { participant_id, kind, token_prefix,
                              joined_at, revoked_at }. Use this to find the
                              participant_id you need to pass to 'revoke'.

  new <pane-id>            Mint a fresh human URL on an existing pane.
                              Returns { participant_id, kind, token, url,
                              created_at } — ONCE. The plaintext token is
                              never recoverable; save the response (pipe to
                              a JSONL log) before delivering the URL.

  revoke <pane-id> <participant-id>
                              Invalidate one participant URL. The pane's
                              other participants (and the agent's own
                              websocket) are untouched. Idempotent: running
                              revoke twice still returns success.
                              Note: existing WebSocket connections held
                              under the revoked token are NOT actively
                              kicked in v1; new HTTP and WS connections
                              under that token will fail with 404.

Options:
  --url <url>                 Relay base URL (overrides PANE_URL).
  --api-key <key>             Agent API key (overrides PANE_API_KEY).
  -h, --help                  Show this help.

Recovery recipe:
  pane list                                       # find pane_id
  pane participant list <pane-id>              # find participant
                                                          #   ids on that
                                                          #   pane
  pane participant new <pane-id>               # mint a new URL
  pane participant revoke <pane-id> <p-id>     # invalidate the
                                                          #   old URL

Output: stdout is machine-readable JSON.`;

async function runParticipantList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, NO_BOOLS, "pane participant list");

  const paneId = args.positionals[1];
  if (!paneId) {
    fail(
      "missing <pane-id> — usage: pane participant list <pane-id>",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    const res = await client.listParticipants(paneId!);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

async function runParticipantNew(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, NO_BOOLS, "pane participant new");

  const paneId = args.positionals[1];
  if (!paneId) {
    fail(
      "missing <pane-id> — usage: pane participant new <pane-id>",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    const res = await client.mintParticipant(paneId!);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

async function runParticipantRevoke(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, NO_BOOLS, "pane participant revoke");

  const paneId = args.positionals[1];
  const participantId = args.positionals[2];
  if (!paneId || !participantId) {
    fail(
      "missing arguments — usage: pane participant revoke <pane-id> <participant-id>",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    await client.revokeParticipant(paneId!, participantId!);
    printJson({
      pane_id: paneId,
      participant_id: participantId,
      revoked: true,
    });
  } catch (e) {
    failFromError(e);
  }
}

export async function runParticipant(args: ParsedArgs): Promise<void> {
  // positionals[0] is the verb (list | new | revoke), positionals[1..] are
  // the verb's args. (The pane.ts dispatcher already shifted off the
  // "participant" marker before calling us.)
  const verb = args.positionals[0];
  switch (verb) {
    case "list":
      await runParticipantList(args);
      break;
    case "new":
      await runParticipantNew(args);
      break;
    case "revoke":
      await runParticipantRevoke(args);
      break;
    case undefined:
      fail(
        "missing verb — usage: pane participant <list|new|revoke> (run 'pane participant --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown participant verb '${verb}' — expected list|new|revoke (run 'pane participant --help')`,
        "invalid_args",
      );
  }
}
