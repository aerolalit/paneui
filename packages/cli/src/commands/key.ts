// `pane key` — inspect or revoke the calling agent's API key.
//
// Flat command namespace: `key` is one top-level noun that branches on a
// positional verb (list / revoke). The relay scopes /v1/keys to the
// authenticated agent, so there is exactly one key — the caller's own. Both
// verbs therefore act ONLY on the caller's own key.

import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

export const keyHelp = `pane key — inspect or revoke YOUR agent's API key

Usage:
  pane key <verb> [options]

Verbs:
  list       Show YOUR agent's key info. The relay scopes keys to the
             authenticated agent — there is exactly one key per agent, your
             own. Prints { agent_id, name, key_prefix, created_at,
             last_used_at, revoked_at }.

  revoke     Revoke YOUR OWN API key — a self-destruct. The key stops working
             IMMEDIATELY; every subsequent command fails until you run
             'pane agent register' again to provision a new key. The relay only
             allows revoking your own key. Requires --yes to confirm.
             Prints { revoked: true, agent_id }.

Options:
  --yes               Confirm 'key revoke' (required — it is irreversible).
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output: stdout is machine-readable JSON.`;

async function runKeyList(args: ParsedArgs): Promise<void> {
  const client = makeClient(args);
  try {
    const info = await client.listKeys();
    printJson(info);
  } catch (e) {
    failFromError(e);
  }
}

async function runKeyRevoke(args: ParsedArgs): Promise<void> {
  if (!args.bools.has("yes")) {
    fail(
      "'pane key revoke' revokes YOUR OWN API key — it stops working " +
        "immediately and is irreversible. Pass --yes to confirm.",
      "confirmation_required",
    );
  }

  const client = makeClient(args);
  try {
    // The relay only permits revoking the caller's own key. If a positional id
    // is given, pass it through and let the relay 403 a wrong one; otherwise
    // resolve the caller's own id from GET /v1/keys.
    const id = args.positionals[1] ?? (await client.listKeys()).agent_id;
    await client.revokeKey(id);
    printJson({ revoked: true, agent_id: id });
  } catch (e) {
    failFromError(e);
  }
}

export async function runKey(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "list":
      await runKeyList(args);
      break;
    case "revoke":
      await runKeyRevoke(args);
      break;
    case undefined:
      fail(
        "missing verb — usage: pane key <list|revoke> (run 'pane key --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown key verb '${sub}' — expected list|revoke (run 'pane key --help')`,
        "invalid_args",
      );
  }
}
