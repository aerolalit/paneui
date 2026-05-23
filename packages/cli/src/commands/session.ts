// `pane session` — the central noun of pane: open, observe, send to, and
// close a session.
//
// A session is one *use* of an artifact: an open URL the human(s) interact
// with, plus an event log the agent reads and appends to. Every other noun
// (artifact, blob, key, taste, feedback) exists in service of sessions.
//
// This file is a thin dispatcher — each verb's actual logic lives in its own
// file (create.ts, state.ts, send.ts, watch.ts, delete.ts). The verb runners
// expect the session id at positionals[0]; we slice off our own verb before
// delegating so they don't need to know they're being called via `session`.

import type { ParsedArgs } from "../argv.js";
import { runCreate } from "./create.js";
import { runState } from "./state.js";
import { runSend } from "./send.js";
import { runWatch } from "./watch.js";
import { runDelete } from "./delete.js";
import { runList, listHelp } from "./list.js";
import { runParticipant, participantHelp } from "./participant.js";
import { fail } from "../output.js";

export const sessionHelp = `pane session — open, observe, send to, and close sessions

A session is one use of an artifact: an open URL the human(s) interact with,
plus an event log the agent reads and appends to.

Usage:
  pane session <verb> [options]

Verbs:
  create            Create a session (POST /v1/sessions). Prints session_id,
                    urls, tokens, expires_at.
  list              Enumerate YOUR agent's sessions. The recovery primitive
                    for "I dropped the create response" — sessions are
                    listable, but participant tokens are stored hashed and
                    CANNOT be recovered. Use 'participant new' to mint a
                    fresh URL.
  show <id>         Non-blocking snapshot: session metadata + event log.
                    Supports --wait <secs> for relay-side long-polling.
  send <id>         Emit an agent event into a session.
  watch <id>        Stream a session's events as JSON-lines on stdout
                    (long-lived; the building block for pipe-readers).
  delete <id>       Close/delete a session (DELETE /v1/sessions/:id).
  participant         List / mint / revoke participant URLs on an existing
    <list|new|revoke> session. 'list' returns the participant ids you need
                      for 'revoke'; 'new' replaces the destructive 'delete
                      + recreate' workaround for a lost URL; 'revoke'
                      invalidates one URL without touching the session.

Run \`pane session <verb> --help\` for verb-specific options.`;

/**
 * Build a new ParsedArgs with the leading positional (the verb) stripped.
 * The downstream verb runners (runState / runSend / runWatch / runDelete)
 * read the session id at positionals[0], so we hand them an args object that
 * looks exactly like the pre-restructure invocation.
 */
function shiftPositionals(args: ParsedArgs): ParsedArgs {
  // Propagate danglingValueFlags too — otherwise the leaf runner's
  // assertKnownFlags can't tell that the user wrote `--title` without a
  // value, and falls through to a less-useful downstream error.
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

export async function runSession(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];

  // `pane session participant --help` (verb-level help on the participant
  // sub-noun, with no further sub-verb). The general --help pre-empt in
  // index.ts only fires when no positional follows the noun; here a
  // positional ("participant") is present, so the sub-noun must own its own
  // --help routing.
  if (
    verb === "participant" &&
    args.bools.has("help") &&
    args.positionals.length === 1
  ) {
    process.stdout.write(participantHelp + "\n");
    return;
  }
  // `pane session list --help` — same pattern.
  if (
    verb === "list" &&
    args.bools.has("help") &&
    args.positionals.length === 1
  ) {
    process.stdout.write(listHelp + "\n");
    return;
  }

  const inner = shiftPositionals(args);
  switch (verb) {
    case "create":
      await runCreate(inner);
      break;
    case "list":
      await runList(inner);
      break;
    case "show":
      await runState(inner);
      break;
    case "send":
      await runSend(inner);
      break;
    case "watch":
      await runWatch(inner);
      break;
    case "delete":
      await runDelete(inner);
      break;
    case "participant":
      await runParticipant(inner);
      break;
    case undefined:
      fail(
        "missing verb — usage: pane session <create|list|show|send|watch|delete|participant> (run 'pane session --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown session verb '${verb}' — expected create|list|show|send|watch|delete|participant (run 'pane session --help')`,
        "invalid_args",
      );
  }
}
