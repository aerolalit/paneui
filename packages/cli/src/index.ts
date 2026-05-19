#!/usr/bin/env node
// pane — command-line client for the Pane relay.
//
// Config: PANE_URL and PANE_API_KEY (env), overridable with --url / --api-key.
// Output is JSON by default. Every command self-documents via --help.

import { parseArgs, ArgvError } from "./argv.js";
import { runCreate, createHelp } from "./commands/create.js";
import { runState, stateHelp } from "./commands/state.js";
import { runSend, sendHelp } from "./commands/send.js";
import { runWatch, watchHelp } from "./commands/watch.js";
import { runRegister, registerHelp } from "./commands/register.js";
import { runArtifact, artifactHelp } from "./commands/artifact.js";
import { runConfig, configHelp } from "./commands/config.js";
import { runLogout, logoutHelp } from "./commands/logout.js";
import { runKeys, keysHelp } from "./commands/keys.js";
import { runDelete, deleteHelp } from "./commands/delete.js";

const VERSION = "0.0.1";

const ROOT_HELP = `pane — a round-trip UI channel between agents and humans

Usage:
  pane <command> [options]

Commands:
  register          Provision an agent API key (POST /v1/register) and save it
                    to the CLI config file. Run this once before other commands.
  create            Create a session (POST /v1/sessions). Prints session_id,
                    urls, tokens, expires_at.
  artifact          Manage reusable, versioned artifacts (create / version /
                    update / search / list / show).
  state <id>        Non-blocking snapshot: session metadata + event log.
  send <id>         Emit an agent event into a session.
  watch <id>        Stream a session's events as JSON-lines on stdout
                    (long-lived; the building block for pipe-readers).
  delete <id>       Close/delete a session (DELETE /v1/sessions/:id).
  keys              Inspect or revoke YOUR agent's API key (list / revoke).
  config            Show the resolved relay config (no network call).
  logout            Clear the locally-saved relay URL + API key.

Run \`pane <command> --help\` for command-specific options.

Config:
  PANE_URL          Relay base URL.        Override: --url <url>
  PANE_API_KEY      Agent API key.         Override: --api-key <key>
  'pane register' provisions the API key and saves it (with the URL) to
  \${XDG_CONFIG_HOME:-~/.config}/pane/config.json — afterwards commands need
  only PANE_URL (or nothing) set.

Global flags:
  -h, --help        Show help.
  -v, --version     Print version.

Output: stdout is machine-readable JSON; errors go to stderr as
{"error":{"code","message"}} with a non-zero exit.`;

// Flags that never take a value. `json` is kept here purely for forward-compat
// (JSON is currently the only output mode): accepting `--json` as a no-op bool
// means a future `--text`/`--json` toggle won't break existing invocations. It
// is intentionally undocumented in --help.
//
// `version` is deliberately NOT here: the top-level `-v` / `--version` is
// handled from rawArgv[0] before parseArgs runs, so it never needs to be a
// boolean flag — and keeping it out lets `pane create --version <n>` /
// `pane artifact version` consume a value as a normal value-flag.
const BOOLEAN_FLAGS = new Set(["json", "once", "help", "print-key", "yes"]);

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);

  // Version: handle before anything else.
  if (rawArgv[0] === "-v" || rawArgv[0] === "--version") {
    process.stdout.write(VERSION + "\n");
    return;
  }

  const command = rawArgv[0];
  const rest = rawArgv.slice(1);

  if (
    command === undefined ||
    command === "-h" ||
    command === "--help" ||
    command === "help"
  ) {
    process.stdout.write(ROOT_HELP + "\n");
    return;
  }

  let args;
  try {
    args = parseArgs(rest, BOOLEAN_FLAGS);
  } catch (e) {
    if (e instanceof ArgvError) {
      process.stderr.write(
        JSON.stringify({
          error: { code: "invalid_args", message: e.message },
        }) + "\n",
      );
      process.exit(1);
    }
    throw e;
  }

  const helps: Record<string, string> = {
    register: registerHelp,
    create: createHelp,
    artifact: artifactHelp,
    state: stateHelp,
    send: sendHelp,
    watch: watchHelp,
    delete: deleteHelp,
    keys: keysHelp,
    config: configHelp,
    logout: logoutHelp,
  };

  if (!(command in helps)) {
    process.stderr.write(
      JSON.stringify({
        error: {
          code: "unknown_command",
          message: `unknown command '${command}' — run 'pane --help'`,
        },
      }) + "\n",
    );
    process.exit(1);
  }

  if (args.bools.has("help")) {
    process.stdout.write(helps[command]! + "\n");
    return;
  }

  switch (command) {
    case "register":
      await runRegister(args);
      break;
    case "create":
      await runCreate(args);
      break;
    case "artifact":
      await runArtifact(args);
      break;
    case "state":
      await runState(args);
      break;
    case "send":
      await runSend(args);
      break;
    case "watch":
      await runWatch(args);
      break;
    case "delete":
      await runDelete(args);
      break;
    case "keys":
      await runKeys(args);
      break;
    case "config":
      await runConfig(args);
      break;
    case "logout":
      await runLogout();
      break;
  }
}

main().catch((err) => {
  process.stderr.write(
    JSON.stringify({
      error: {
        code: "internal",
        message: err instanceof Error ? err.message : String(err),
      },
    }) + "\n",
  );
  process.exit(1);
});
