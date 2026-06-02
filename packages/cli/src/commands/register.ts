// `pane agent register` — self-provision an agent API key from the relay.
//
// This is the one command that needs no API key: it is the call that obtains
// one. If the relay runs REGISTRATION_MODE=secret, pass the shared
// registration secret via --secret or PANE_REGISTER_SECRET. On success the key
// (and relay URL) are persisted under a named profile in the CLI config file,
// so every later command works with only PANE_URL (or nothing) set.

import { registerAgent, PaneApiError } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { DEFAULT_RELAY_URL } from "../config.js";
import { printJson, fail, failUpgradeRequired } from "../output.js";
import {
  isValidProfileName,
  DEFAULT_PROFILE_NAME,
  readStore,
  resolveProfile,
  upsertProfile,
} from "../store.js";
import { VERSION } from "../version.js";

const KNOWN_FLAGS = ["name", "secret"];
const KNOWN_BOOLS = ["print-key"];

export const registerHelp = `pane agent register — register this agent with the relay and save the key locally

Usage:
  pane agent register [options]

Calls POST /v1/register, then saves the returned API key (and relay URL) under
a named profile in the CLI config file — so afterwards every other command
works with only PANE_URL set (no PANE_API_KEY needed).

If --profile is omitted, the registered key goes under the currently-active
profile (or 'default' for a fresh install). Pass --profile <name> to keep
multiple environments (dev/staging/prod) side by side; switch between them
with 'pane config use <name>' or '--profile <name>' / PANE_PROFILE.

Options:
  --name <n>          Agent display name on the relay. The relay defaults it
                      if omitted.
  --profile <name>    Local profile name to save under. Defaults to the active
                      profile, or 'default' on a fresh install. Letters,
                      digits, _ and -, up to 32 chars.
  --url <url>         Relay base URL. Falls back to PANE_URL, then the active
                      profile, then the hosted Pane relay. Self-hosters set
                      this.
  --secret <s>        Registration secret, sent as a Bearer token. Only needed
                      when the relay uses REGISTRATION_MODE=secret. Falls back
                      to the PANE_REGISTER_SECRET env var.
  --print-key         Also echo the full api_key in the output. By default the
                      key is only persisted to the config file, never printed.
  -h, --help          Show this help.

Output (stdout, JSON):
  { agent_id, key_prefix, profile, saved_to }   (+ api_key when --print-key)

The API key is saved to the CLI config file (mode 0600); it is not printed
unless --print-key is passed.`;

export async function runRegister(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane agent register");

  // Profile selection for the WRITE side: --profile flag → PANE_PROFILE env
  // → the store's current profile → DEFAULT_PROFILE_NAME ('default') for
  // a fresh install. We deliberately don't fall through to "no profile, use
  // a fresh name" — the agent needs to end up somewhere callable, and
  // 'default' is a stable, predictable home.
  const profileFlag = args.flags.get("profile") ?? process.env.PANE_PROFILE;
  const store = readStore();
  const profileName =
    profileFlag !== undefined && profileFlag !== ""
      ? profileFlag
      : (store.currentProfile ?? DEFAULT_PROFILE_NAME);

  if (!isValidProfileName(profileName)) {
    fail(
      `invalid profile name '${profileName}' — letters, digits, _ and -, up to 32 chars`,
      "invalid_args",
    );
  }

  // URL precedence for the relay we're registering against:
  //   --url flag > PANE_URL env > target-profile's existing url > default.
  // The "target profile's url" path means re-running `pane agent register
  // --profile dev` against a profile that already exists keeps hitting the
  // same dev relay without retyping --url.
  let activeUrl: string | undefined;
  try {
    const active = resolveProfile(store, profileFlag);
    activeUrl = active?.profile.url;
  } catch {
    // Selector didn't resolve — fine on register: we're about to create it.
    activeUrl = undefined;
  }
  const url =
    args.flags.get("url") ??
    process.env.PANE_URL ??
    activeUrl ??
    DEFAULT_RELAY_URL;

  const name = args.flags.get("name");
  const secret =
    args.flags.get("secret") ?? process.env.PANE_REGISTER_SECRET ?? undefined;

  let result;
  try {
    result = await registerAgent({
      url: url.replace(/\/$/, ""),
      ...(name !== undefined ? { name } : {}),
      ...(secret !== undefined && secret !== "" ? { secret } : {}),
      cliVersion: VERSION,
    });
  } catch (e) {
    if (e instanceof PaneApiError) {
      // 426 cli_upgrade_required goes through the shared upgrade-message
      // path (stderr block + exit 75) so the SKILL.md's instructions to the
      // agent's harness fire on `pane agent register` too.
      if (e.status === 426 && e.code === "cli_upgrade_required") {
        failUpgradeRequired(e);
      }
      if (e.status === 429) {
        fail(
          "registration rate limit exceeded — try again later",
          "rate_limited",
          undefined,
          { hint: e.hint, retryable: e.retryable, docs_url: e.docsUrl },
        );
      }
      fail(e.message, e.code, e.details, {
        hint: e.hint,
        retryable: e.retryable,
        docs_url: e.docsUrl,
      });
    }
    fail(e instanceof Error ? e.message : String(e), "internal");
  }

  // Save under the chosen profile. We pass setCurrent=true: the user just
  // registered against this relay, so the only sensible follow-up is to
  // start using it. The previous behaviour (one global URL+key) is exactly
  // the single-profile case of this.
  const savedTo = upsertProfile(
    profileName,
    { url: url.replace(/\/$/, ""), apiKey: result.api_key },
    true,
  );

  const out: Record<string, unknown> = {
    agent_id: result.agent_id,
    key_prefix: result.key_prefix,
    profile: profileName,
    saved_to: savedTo,
  };
  if (args.bools.has("print-key")) {
    out["api_key"] = result.api_key;
  }
  printJson(out);
}
