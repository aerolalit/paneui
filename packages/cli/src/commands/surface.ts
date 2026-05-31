// `pane surface` — the central noun of pane: open, observe, send to, and
// close a surface.
//
// A surface is one *use* of an template: an open URL the human(s) interact
// with, plus an event log the agent reads and appends to. Every other noun
// (template, attachment, key, taste, feedback) exists in service of surfaces.
//
// This file is a thin dispatcher — each verb's actual logic lives in its own
// file (create.ts, state.ts, send.ts, watch.ts, delete.ts). The verb runners
// expect the surface id at positionals[0]; we slice off our own verb before
// delegating so they don't need to know they're being called via `surface`.

import type { ParsedArgs } from "../argv.js";
import { runCreate } from "./create.js";
import { runState } from "./state.js";
import { runSend } from "./send.js";
import { runWatch } from "./watch.js";
import { runDelete } from "./delete.js";
import { runList, listHelp } from "./list.js";
import { runParticipant, participantHelp } from "./participant.js";
import { fail } from "../output.js";

export const surfaceHelp = `pane surface — open, observe, send to, and close surfaces

A surface is one use of an template: an open URL the human(s) interact with,
plus an event log the agent reads and appends to.

Usage:
  pane surface <verb> [options]

Verbs:
  create            Create a surface (POST /v1/surfaces). Prints surface_id,
                    urls, tokens, expires_at.
  list              Enumerate YOUR agent's surfaces. The recovery primitive
                    for "I dropped the create response" — surfaces are
                    listable, but participant tokens are stored hashed and
                    CANNOT be recovered. Use 'participant new' to mint a
                    fresh URL.
  show <id>         Non-blocking snapshot: surface metadata + event log.
                    Supports --wait <secs> for relay-side long-polling.
  send <id>         Emit an agent event into a surface.
  watch <id>        Stream a surface's events as JSON-lines on stdout
                    (long-lived; the building block for pipe-readers).
  delete <id>       Close/delete a surface (DELETE /v1/surfaces/:id).
  participant         List / mint / revoke participant URLs on an existing
    <list|new|revoke> surface. 'list' returns the participant ids you need
                      for 'revoke'; 'new' replaces the destructive 'delete
                      + recreate' workaround for a lost URL; 'revoke'
                      invalidates one URL without touching the surface.

Run \`pane surface <verb> --help\` for verb-specific options.`;

/**
 * Build a new ParsedArgs with the leading positional (the verb) stripped.
 * The downstream verb runners (runState / runSend / runWatch / runDelete)
 * read the surface id at positionals[0], so we hand them an args object that
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

export async function runSurface(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];

  // `pane surface participant --help` (verb-level help on the participant
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
  // `pane surface list --help` — same pattern.
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
        "missing verb — usage: pane surface <create|list|show|send|watch|delete|participant> (run 'pane surface --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown surface verb '${verb}' — expected create|list|show|send|watch|delete|participant (run 'pane surface --help')`,
        "invalid_args",
      );
  }
}
