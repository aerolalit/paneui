// `pane agent` — agent-lifecycle operations: register a new API key, or
// clear the locally-saved one.
//
// Both verbs are about the calling agent's identity on this machine:
//   register   provision an API key from the relay (one-shot bootstrap)
//   logout     clear the locally-saved relay URL + API key
//
// This file is a thin dispatcher — actual logic lives in register.ts and
// logout.ts.

import type { ParsedArgs } from "../argv.js";
import { runRegister } from "./register.js";
import { runLogout } from "./logout.js";
import { fail } from "../output.js";

export const agentHelp = `pane agent — manage this agent's identity on the relay

Usage:
  pane agent <verb> [options]

Verbs:
  register          Provision an agent API key (POST /v1/register) and save it
                    to the CLI config file. Run this once before other commands.
  logout            Clear the locally-saved relay URL + API key. Does NOT
                    revoke the key on the relay — use 'pane key revoke' for
                    that.

Run \`pane agent <verb> --help\` for verb-specific options.`;

export async function runAgent(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  switch (verb) {
    case "register":
      await runRegister(args);
      break;
    case "logout":
      await runLogout();
      break;
    case undefined:
      fail(
        "missing verb — usage: pane agent <register|logout> (run 'pane agent --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown agent verb '${verb}' — expected register|logout (run 'pane agent --help')`,
        "invalid_args",
      );
  }
}
