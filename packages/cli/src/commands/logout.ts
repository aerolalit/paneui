// `pane agent logout` — clear the locally-saved relay URL + API key.

import { clearStore } from "../store.js";
import { printJson } from "../output.js";

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

export async function runLogout(): Promise<void> {
  const path = clearStore();
  printJson({ cleared: true, path });
}
