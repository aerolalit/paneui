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
import { fail } from "../output.js";

export const sessionHelp = `pane session — open, observe, send to, and close sessions

A session is one use of an artifact: an open URL the human(s) interact with,
plus an event log the agent reads and appends to.

Usage:
  pane session <verb> [options]

Verbs:
  create            Create a session (POST /v1/sessions). Prints session_id,
                    urls, tokens, expires_at.
  show <id>         Non-blocking snapshot: session metadata + event log.
                    Supports --wait <secs> for relay-side long-polling.
  send <id>         Emit an agent event into a session.
  watch <id>        Stream a session's events as JSON-lines on stdout
                    (long-lived; the building block for pipe-readers).
  delete <id>       Close/delete a session (DELETE /v1/sessions/:id).

Run \`pane session <verb> --help\` for verb-specific options.`;

/**
 * Build a new ParsedArgs with the leading positional (the verb) stripped.
 * The downstream verb runners (runState / runSend / runWatch / runDelete)
 * read the session id at positionals[0], so we hand them an args object that
 * looks exactly like the pre-restructure invocation.
 */
function shiftPositionals(args: ParsedArgs): ParsedArgs {
  return {
    positionals: args.positionals.slice(1),
    flags: args.flags,
    bools: args.bools,
  };
}

export async function runSession(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  const inner = shiftPositionals(args);
  switch (verb) {
    case "create":
      await runCreate(inner);
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
    case undefined:
      fail(
        "missing verb — usage: pane session <create|show|send|watch|delete> (run 'pane session --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown session verb '${verb}' — expected create|show|send|watch|delete (run 'pane session --help')`,
        "invalid_args",
      );
  }
}
