#!/usr/bin/env node
// pane — command-line client for the Pane relay.
//
// Shape: uniform `pane <noun> <verb> [options]`. Every command lives under a
// noun; nothing is a bare top-level verb. See issue #163 for the rationale
// behind the shape and the rename from the older flat layout.
//
// Config: PANE_URL and PANE_API_KEY (env), overridable with --url / --api-key.
// Output is JSON by default. Every noun self-documents via --help.

import { parseArgs, ArgvError } from "./argv.js";
import { runSession, sessionHelp } from "./commands/session.js";
import { runArtifact, artifactHelp } from "./commands/artifact.js";
import { runAgent, agentHelp } from "./commands/agent.js";
import { runKey, keyHelp } from "./commands/key.js";
import { runTaste, tasteHelp } from "./commands/taste.js";
import { runFeedback, feedbackHelp } from "./commands/feedback.js";
import { runConfig, configHelp } from "./commands/config.js";
import { runBlob, blobHelp } from "./commands/blob.js";
import { runSkill, skillHelp } from "./commands/skill.js";
import { VERSION } from "./version.js";
import { PaneApiError } from "@paneui/core";
import { failUpgradeRequired } from "./output.js";

const ROOT_HELP = `pane — a round-trip UI channel between agents and humans

Usage:
  pane <noun> <verb> [options]

Nouns:
  session           Open / observe / send to / close sessions
                    (create | list | show | send | watch | delete |
                     participant <list|new|revoke>).
  artifact          Reusable, versioned UI templates
                    (create | version | update | search | list | show | delete).
  key               YOUR agent's API key (list | revoke).
  taste             YOUR agent's freeform UI taste notes
                    (get | set | clear) — presentation preferences the agent
                    has learned from human feedback and reads before
                    generating a pane artifact.
  feedback          One-shot feedback to the relay operator
                    (create | list) — bug reports, feature requests, notes.
  blob              Binary attachments (upload | download | show | list |
                    delete | token <mint|revoke|list>). Blobs are scoped to
                    an agent, a session, or an artifact, and can be referenced
                    from event payloads + input_data via
                    \`format: pane-blob-id\`.
  agent             Agent identity on this machine (register | logout).
  config            CLI config inspection (show).
  skill             The relay's SKILL.md (show | version) — auto-updating;
                    no API key required.

Run \`pane <noun> --help\` for that noun's verbs.

Config:
  PANE_URL          Relay base URL.        Override: --url <url>
  PANE_API_KEY      Agent API key.         Override: --api-key <key>
  'pane agent register' provisions the API key and saves it (with the URL) to
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
// boolean flag — and keeping it out lets `pane session create --version <n>` /
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

  const noun = rawArgv[0];
  const rest = rawArgv.slice(1);

  if (
    noun === undefined ||
    noun === "-h" ||
    noun === "--help" ||
    noun === "help"
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
    session: sessionHelp,
    artifact: artifactHelp,
    key: keyHelp,
    taste: tasteHelp,
    feedback: feedbackHelp,
    blob: blobHelp,
    agent: agentHelp,
    config: configHelp,
    skill: skillHelp,
  };

  if (!(noun in helps)) {
    process.stderr.write(
      JSON.stringify({
        error: {
          code: "unknown_command",
          message: `unknown command '${noun}' — run 'pane --help'`,
        },
      }) + "\n",
    );
    process.exit(1);
  }

  // `pane <noun> --help` with no verb prints the noun-level help. A verb-level
  // --help is the responsibility of each runner (e.g. runSession dispatches to
  // the verb runner which reads its own xxxHelp). This pre-empt only fires
  // when --help is the FIRST positional-equivalent — i.e. no verb given.
  if (args.bools.has("help") && args.positionals.length === 0) {
    process.stdout.write(helps[noun]! + "\n");
    return;
  }

  switch (noun) {
    case "session":
      await runSession(args);
      break;
    case "artifact":
      await runArtifact(args);
      break;
    case "key":
      await runKey(args);
      break;
    case "taste":
      await runTaste(args);
      break;
    case "feedback":
      await runFeedback(args);
      break;
    case "blob":
      await runBlob(args);
      break;
    case "agent":
      await runAgent(args);
      break;
    case "config":
      await runConfig(args);
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
