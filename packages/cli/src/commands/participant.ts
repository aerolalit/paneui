// `pane participant new|revoke` — mint or invalidate one participant URL on
// an existing session. Recovery + leak-containment primitives that together
// replace the destructive `pane delete + create` workaround.

import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

export const participantHelp = `pane participant — manage one session's participant URLs

Participant tokens are stored hashed on the relay and CANNOT be recovered.
If you lost the create-response (and the URL with it), use 'new' to mint a
fresh URL — the session keeps its event log, artifact pin, and created_at.
Use 'revoke' to invalidate a single URL while keeping the session alive.

Usage:
  pane participant <subcommand> <args>

Subcommands:
  new <session-id>            Mint a fresh human URL on an existing session.
                              Returns { participant_id, kind, token, url,
                              created_at } — ONCE. The plaintext token is
                              never recoverable; save the response (pipe to
                              a JSONL log) before delivering the URL.

  revoke <session-id> <participant-id>
                              Invalidate one participant URL. The session's
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
  pane list                                          # find session_id + p_id
  pane participant new <session-id>                  # mint a new URL
  pane participant revoke <session-id> <p-id>        # invalidate the old URL

Output: stdout is machine-readable JSON.`;

async function runParticipantNew(args: ParsedArgs): Promise<void> {
  const sessionId = args.positionals[1];
  if (!sessionId) {
    fail(
      "missing <session-id> — usage: pane participant new <session-id>",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    const res = await client.mintParticipant(sessionId!);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

async function runParticipantRevoke(args: ParsedArgs): Promise<void> {
  const sessionId = args.positionals[1];
  const participantId = args.positionals[2];
  if (!sessionId || !participantId) {
    fail(
      "missing arguments — usage: pane participant revoke <session-id> <participant-id>",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    await client.revokeParticipant(sessionId!, participantId!);
    printJson({
      session_id: sessionId,
      participant_id: participantId,
      revoked: true,
    });
  } catch (e) {
    failFromError(e);
  }
}

export async function runParticipant(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "new":
      await runParticipantNew(args);
      break;
    case "revoke":
      await runParticipantRevoke(args);
      break;
    case undefined:
      fail(
        "missing subcommand — usage: pane participant <new|revoke> (run 'pane participant --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown participant subcommand '${sub}' — expected new|revoke (run 'pane participant --help')`,
        "invalid_args",
      );
  }
}
