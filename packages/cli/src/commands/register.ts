// `pane register` — self-provision an agent API key from the relay.
//
// This is the one command that needs no API key: it is the call that obtains
// one. On success the key (and relay URL) are persisted to the CLI config
// file, so every later command works with only PANE_URL (or nothing) set.

import { registerAgent, PaneApiError } from "@pane/core";
import type { ParsedArgs } from "../argv.js";
import { printJson, fail } from "../output.js";
import { readStore, writeStore } from "../store.js";

export const registerHelp = `pane register — provision an agent API key

Usage:
  pane register --secret <registration-secret> [options]

The relay must have been started with REGISTRATION_SECRET set; the operator
shares that secret with you. This command calls POST /v1/register, then saves
the returned API key (and relay URL) to the CLI config file — so afterwards
every other command works with only PANE_URL set (no PANE_API_KEY needed).

Required:
  --secret <s>        Registration secret. Falls back to the
                      PANE_REGISTRATION_SECRET environment variable.

Options:
  --name <n>          Agent display name. The relay defaults it if omitted.
  --url <url>         Relay base URL (falls back to PANE_URL, then config file).
  --print-key         Also echo the full api_key in the output. By default the
                      key is only persisted to the config file, never printed.
  -h, --help          Show this help.

Output (stdout, JSON):
  { agent_id, key_prefix, saved_to }   (+ api_key when --print-key is given)

The API key is saved to the CLI config file (mode 0600); it is not printed
unless --print-key is passed.`;

export async function runRegister(args: ParsedArgs): Promise<void> {
  const store = readStore();
  const url = args.flags.get("url") ?? process.env.PANE_URL ?? store.url ?? "";
  if (!url) {
    fail(
      "missing relay URL: set PANE_URL or pass --url <relay-base-url>",
      "config_error",
    );
  }

  const secret =
    args.flags.get("secret") ?? process.env.PANE_REGISTRATION_SECRET ?? "";
  if (!secret) {
    fail(
      "missing registration secret: pass --secret <s> or set PANE_REGISTRATION_SECRET",
      "config_error",
    );
  }

  const name = args.flags.get("name");

  let result;
  try {
    result = await registerAgent({
      url: url.replace(/\/$/, ""),
      registrationSecret: secret,
      ...(name !== undefined ? { name } : {}),
    });
  } catch (e) {
    if (e instanceof PaneApiError) {
      if (e.status === 404) {
        fail(
          "relay has registration disabled (no REGISTRATION_SECRET configured server-side)",
          "registration_disabled",
        );
      }
      if (e.status === 401) {
        fail("registration secret rejected by the relay", "unauthorized");
      }
      fail(e.message, e.code, e.details);
    }
    fail(e instanceof Error ? e.message : String(e), "internal");
  }

  const savedTo = writeStore({ url: url.replace(/\/$/, ""), apiKey: result.api_key });

  const out: Record<string, unknown> = {
    agent_id: result.agent_id,
    key_prefix: result.key_prefix,
    saved_to: savedTo,
  };
  if (args.bools.has("print-key")) {
    out["api_key"] = result.api_key;
  }
  printJson(out);
}
