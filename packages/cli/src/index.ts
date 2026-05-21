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
import { runTaste, tasteHelp } from "./commands/taste.js";
import { runFeedback, feedbackHelp } from "./commands/feedback.js";
import { runDelete, deleteHelp } from "./commands/delete.js";
import { runList, listHelp } from "./commands/list.js";
import { runParticipant, participantHelp } from "./commands/participant.js";
import { runSkill, skillHelp } from "./commands/skill.js";
import { VERSION } from "./version.js";
import { PaneApiError } from "@paneui/core";
import { failUpgradeRequired } from "./output.js";

const ROOT_HELP = `pane — a round-trip UI channel between agents and humans

Usage:
  pane <command> [options]

Commands:
  register          Provision an agent API key (POST /v1/register) and save it
                    to the CLI config file. Run this once before other commands.
  create            Create a session (POST /v1/sessions). Prints session_id,
                    urls, tokens, expires_at.
  artifact          Manage reusable, versioned artifacts (create / version /
                    update / search / list / show / delete).
  state <id>        Non-blocking snapshot: session metadata + event log.
  send <id>         Emit an agent event into a session.
  watch <id>        Stream a session's events as JSON-lines on stdout
                    (long-lived; the building block for pipe-readers).
  delete <id>       Close/delete a session (DELETE /v1/sessions/:id).
  list              Enumerate YOUR agent's sessions. The recovery primitive
                    for "I dropped the create response" — sessions are
                    listable, but participant tokens are stored hashed and
                    CANNOT be recovered. Use 'participant new' to mint a
                    fresh URL.
  participant       Mint or revoke a single participant URL on an existing
                    session (new / revoke). 'new' replaces the destructive
                    'delete + recreate' workaround for a lost URL; 'revoke'
                    invalidates one URL without touching the session.
  keys              Inspect or revoke YOUR agent's API key (list / revoke).
  taste             Read / write / clear YOUR agent's UI taste notes
                    (get / set / clear) — presentation preferences the agent
                    has learned from human feedback and reads before
                    generating a pane artifact.
  feedback          Submit / list one-shot feedback to the relay operator
                    (create / list) — bug reports, feature requests, notes.
  config            Show the resolved relay config (no network call).
  logout            Clear the locally-saved relay URL + API key.
  skill             Fetch the relay's SKILL.md to stdout, or just its
                    version with 'pane skill version'. Used to install
                    and keep the local skill copy in sync; no API key.

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
const BOOLEAN_FLAGS = new Set([
  "json",
  "once",
  "help",
  "print-key",
  "yes",
  "plain",
]);

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
    list: listHelp,
    participant: participantHelp,
    keys: keysHelp,
    taste: tasteHelp,
    feedback: feedbackHelp,
    config: configHelp,
    logout: logoutHelp,
    skill: skillHelp,
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
    case "list":
      await runList(args);
      break;
    case "participant":
      await runParticipant(args);
      break;
    case "keys":
      await runKeys(args);
      break;
    case "taste":
      await runTaste(args);
      break;
    case "feedback":
      await runFeedback(args);
      break;
    case "config":
      await runConfig(args);
      break;
    case "logout":
      await runLogout();
      break;
    case "skill":
      await runSkill(args);
      break;
  }
}

main().catch((err) => {
  // Funnel 426 cli_upgrade_required through the dedicated upgrade-message
  // path so a command that throws raw (instead of going through
  // failFromError) still produces the exact stderr block + exit 75 the
  // SKILL.md tells the agent's harness to expect.
  if (
    err instanceof PaneApiError &&
    err.code === "cli_upgrade_required" &&
    err.status === 426
  ) {
    failUpgradeRequired(err);
  }
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
