// `pane agent logout` — clear one (or all) saved profile(s).

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import {
  clearStore,
  readStore,
  removeProfile,
  resolveProfile,
} from "../store.js";
import { printJson, fail } from "../output.js";

const NO_FLAGS: string[] = [];
const KNOWN_BOOLS = ["all"];

export const logoutHelp = `pane agent logout — clear a saved profile (or all of them)

Usage:
  pane agent logout [options]

By default this clears the ACTIVE profile only (the one selected by --profile
/ PANE_PROFILE / the store's current_profile). The on-disk file keeps the
other profiles, and 'current_profile' is unset so the next command falls back
to env / default URL until another profile is selected.

Pass --all to delete the whole config file (the pre-profile behaviour) — this
wipes every profile, not just the active one. Idempotent — no error if there
is nothing to clear.

This only clears the LOCAL config. It does NOT revoke the key on the relay —
keys keep working until revoked. To revoke a key server-side, use
'pane key revoke'.

Options:
  --profile <name>    Target this profile instead of the active one.
  --all               Delete every profile (the whole config file).
  -h, --help          Show this help.

Output (stdout, JSON):
  { cleared: true, profile, path }   (profile=null when --all)`;

export async function runLogout(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, KNOWN_BOOLS, "pane agent logout");

  if (args.bools.has("all")) {
    // Nuke everything — file gone, both legacy and new shape covered.
    const path = clearStore();
    printJson({ cleared: true, profile: null, path });
    return;
  }

  const store = readStore();
  const selector = args.flags.get("profile") ?? process.env.PANE_PROFILE;
  let target: {
    name: string;
    profile: { url?: string; apiKey?: string };
  } | null;
  try {
    target = resolveProfile(store, selector);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "config_error");
  }

  // Nothing to clear: empty store or legacy file with no migrate yet.
  if (!target) {
    // If there's literally nothing saved, mirror the legacy idempotent
    // behaviour — delete the file (no-op if absent) and report cleared.
    const path = clearStore();
    printJson({ cleared: true, profile: null, path });
    return;
  }

  const { path } = removeProfile(target.name);
  printJson({ cleared: true, profile: target.name, path });
}
