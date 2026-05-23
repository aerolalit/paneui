// `pane agent logout` — clear the locally-saved relay URL + API key.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { clearStore } from "../store.js";
import { printJson } from "../output.js";

const NO_FLAGS: string[] = [];
const NO_BOOLS: string[] = [];

export const logoutHelp = `pane agent logout — clear the saved relay URL + API key

Usage:
  pane agent logout [options]

Deletes the CLI config file (\${XDG_CONFIG_HOME:-~/.config}/pane/config.json),
which holds the relay URL and the agent API key saved by 'pane agent register'.
Idempotent — no error if there is nothing to clear.

This only clears the LOCAL config. It does NOT revoke the key on the relay —
the key keeps working until it is revoked. To revoke it on the relay, use
'pane key revoke'.

Options:
  -h, --help          Show this help.

Output (stdout, JSON):
  { cleared: true, path }`;

export async function runLogout(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, NO_BOOLS, "pane agent logout");

  const path = clearStore();
  printJson({ cleared: true, path });
}
