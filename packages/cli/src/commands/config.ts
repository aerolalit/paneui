// `pane config <verb>` — inspect and manage the multi-profile CLI config.
//
//   show              describe the resolved (url, api_key) the CLI would use
//   list              list saved profiles (names + URLs + current marker)
//   use <name>        switch the active profile
//   add <name>        manually add a profile (for keys obtained out of band)
//   rm <name>         delete a profile
//
// All four mutating verbs operate on the multi-profile store at
// $XDG_CONFIG_HOME/pane/config.json. See store.ts for the layout. They make
// NO network calls — purely local config management.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { describeConfig } from "../config.js";
import {
  isValidProfileName,
  readStore,
  removeProfile,
  setCurrentProfile,
  storePath,
  upsertProfile,
} from "../store.js";
import { printJson, fail } from "../output.js";

const SHOW_FLAGS: string[] = [];
const SHOW_BOOLS: string[] = [];

const LIST_FLAGS: string[] = [];
const LIST_BOOLS: string[] = [];

const USE_FLAGS: string[] = [];
const USE_BOOLS: string[] = [];

const ADD_FLAGS = ["api-key"];
const ADD_BOOLS: string[] = [];

const RM_FLAGS: string[] = [];
const RM_BOOLS: string[] = [];

export const configHelp = `pane config — show and manage the CLI config (multi-profile)

Usage:
  pane config show                      Show the resolved relay config
  pane config list                      List saved profiles
  pane config use <profile>             Switch the active profile
  pane config add <profile> --url <u> --api-key <k>
                                        Add a profile manually
  pane config rm <profile>              Delete a profile

A profile is one (url, api_key) pair under a short name (dev, staging, prod).
Switch via 'pane config use', '--profile <name>', or the PANE_PROFILE env var.
The active profile's (url, api_key) is what every other command sees unless
overridden by --url / --api-key or PANE_URL / PANE_API_KEY.

Run \`pane config <verb> --help\` for verb-specific help. The full API key is
never printed; only a short masked prefix.

The config file lives at \${XDG_CONFIG_HOME:-~/.config}/pane/config.json
(mode 0600).`;

const showHelp = `pane config show — show the resolved relay config

Usage:
  pane config show [options]

Reports the (url, api_key) the CLI would use right now, and where each value
came from (flag / env / profile / none). Purely inspects flags + env + the
saved config file; makes NO network call.

The API key is never printed in full — only a short masked prefix.

Options:
  --url <url>         Relay base URL (overrides PANE_URL) — affects the report.
  --api-key <key>     Agent API key (overrides PANE_API_KEY) — affects the report.
  --profile <name>    Profile to resolve against — affects the report.
  -h, --help          Show this help.

Output (stdout, JSON):
  {
    url, url_source,        flag | env | profile | none
    key_prefix, key_source, flag | env | profile | none
    profile, profile_source,  active profile name + how it was chosen
    config_path
  }`;

const listHelp = `pane config list — list saved profiles

Usage:
  pane config list [options]

Prints every profile in the local config file, with its URL and a masked
key prefix. The active profile carries 'current: true'.

Options:
  -h, --help          Show this help.

Output (stdout, JSON):
  {
    current: <name|null>,
    profiles: [ { name, url, key_prefix, current }, … ],
    config_path
  }`;

const useHelp = `pane config use <profile> — switch the active profile

Usage:
  pane config use <profile>

Sets 'current_profile' in the config file. The named profile must exist
(create it first with 'pane agent register --profile <name>' or
'pane config add <name>').

Options:
  -h, --help          Show this help.

Output (stdout, JSON):
  { profile, saved_to }`;

const addHelp = `pane config add <profile> — add a profile manually

Usage:
  pane config add <profile> --url <url> --api-key <api-key>

Saves a (url, api_key) pair under <profile> without contacting the relay.
Use this when an operator handed you an API key out of band (e.g. a closed-
registration relay) — for self-register and secret-mode relays, prefer
'pane agent register --profile <name>'.

If <profile> already exists, the existing values are overwritten.

Options:
  --url <url>         Relay base URL.            REQUIRED.
  --api-key <key>     Agent API key.             REQUIRED.
  -h, --help          Show this help.

Output (stdout, JSON):
  { profile, saved_to }

Does NOT change 'current_profile' unless this is the first profile being
added. Use 'pane config use' afterwards to switch.`;

const rmHelp = `pane config rm <profile> — delete a profile

Usage:
  pane config rm <profile>

Removes the named profile from the config file. If it was the active profile,
'current_profile' is cleared (the next command falls back to env / default
URL until another profile is selected via --profile or 'pane config use').

Options:
  -h, --help          Show this help.

Output (stdout, JSON):
  { profile, was_current, path }`;

async function runConfigShow(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, SHOW_FLAGS, SHOW_BOOLS, "pane config show");
  printJson(describeConfig(args));
}

function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.startsWith("pane_") && key.length >= 11)
    return key.slice(0, 11) + "…";
  return key.slice(0, 8) + "…";
}

async function runConfigList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, LIST_FLAGS, LIST_BOOLS, "pane config list");
  const store = readStore();
  const profiles = Object.entries(store.profiles)
    .map(([name, p]) => ({
      name,
      url: p.url ?? null,
      key_prefix: maskKey(p.apiKey),
      current: name === store.currentProfile,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  printJson({
    current: store.currentProfile ?? null,
    profiles,
    config_path: storePath(),
  });
}

async function runConfigUse(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, USE_FLAGS, USE_BOOLS, "pane config use");
  const name = args.positionals[1];
  if (!name) {
    fail(
      "missing profile name — usage: pane config use <profile>",
      "invalid_args",
    );
  }
  let savedTo: string;
  try {
    savedTo = setCurrentProfile(name);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "config_error");
  }
  printJson({ profile: name, saved_to: savedTo });
}

async function runConfigAdd(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ADD_FLAGS, ADD_BOOLS, "pane config add");
  const name = args.positionals[1];
  if (!name) {
    fail(
      "missing profile name — usage: pane config add <profile> --url <url> --api-key <key>",
      "invalid_args",
    );
  }
  if (!isValidProfileName(name)) {
    fail(
      `invalid profile name '${name}' — letters, digits, _ and -, up to 32 chars`,
      "invalid_args",
    );
  }
  const url = args.flags.get("url");
  const apiKey = args.flags.get("api-key");
  if (!url) {
    fail(
      "--url is required — usage: pane config add <profile> --url <url> --api-key <key>",
      "invalid_args",
    );
  }
  if (!apiKey) {
    fail(
      "--api-key is required — usage: pane config add <profile> --url <url> --api-key <key>",
      "invalid_args",
    );
  }
  // setCurrent=false: adding a profile shouldn't silently switch the user
  // off whatever they were on. They use `pane config use` after to flip.
  // EXCEPT: if there's no current profile yet (first add), upsertProfile
  // sets it automatically — that's the correct fresh-install behaviour.
  const savedTo = upsertProfile(
    name,
    { url: url.replace(/\/$/, ""), apiKey },
    false,
  );
  printJson({ profile: name, saved_to: savedTo });
}

async function runConfigRm(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, RM_FLAGS, RM_BOOLS, "pane config rm");
  const name = args.positionals[1];
  if (!name) {
    fail(
      "missing profile name — usage: pane config rm <profile>",
      "invalid_args",
    );
  }
  let result: { path: string; was_current: boolean };
  try {
    result = removeProfile(name);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "config_error");
  }
  printJson({
    profile: name,
    was_current: result.was_current,
    path: result.path,
  });
}

export async function runConfig(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];

  // Per-verb --help: 'pane config show --help' etc. Caught before dispatch
  // so each runner doesn't need to repeat the check.
  if (args.bools.has("help") && verb !== undefined) {
    const helps: Record<string, string> = {
      show: showHelp,
      list: listHelp,
      use: useHelp,
      add: addHelp,
      rm: rmHelp,
    };
    if (helps[verb] !== undefined) {
      process.stdout.write(helps[verb] + "\n");
      return;
    }
  }

  switch (verb) {
    case "show":
      await runConfigShow(args);
      break;
    case "list":
      await runConfigList(args);
      break;
    case "use":
      await runConfigUse(args);
      break;
    case "add":
      await runConfigAdd(args);
      break;
    case "rm":
      await runConfigRm(args);
      break;
    case undefined:
      fail(
        "missing verb — usage: pane config <show|list|use|add|rm> (run 'pane config --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown config verb '${verb}' — expected show|list|use|add|rm (run 'pane config --help')`,
        "invalid_args",
      );
  }
}
