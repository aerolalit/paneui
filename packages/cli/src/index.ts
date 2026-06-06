#!/usr/bin/env node
// pane — command-line client for the Pane relay.
//
// Shape: uniform `pane <noun> <verb> [options]`. Every command lives under a
// noun; nothing is a bare top-level verb. See issue #163 for the rationale
// behind the shape and the rename from the older flat layout.
//
// Config: PANE_URL and PANE_API_KEY (env), overridable with --url / --api-key.
// Multiple environments live as named profiles in
// $XDG_CONFIG_HOME/pane/config.json; pick one with --profile or PANE_PROFILE.
// Output is JSON by default. Every noun self-documents via --help.

import { parseArgs, ArgvError } from "./argv.js";

/**
 * Translate an ArgvError into the canonical `invalid_args` envelope and exit
 * non-zero. The parser throws ArgvError up-front; assertKnownFlags throws it
 * from inside a runner. Both paths funnel here so the on-wire shape is one.
 */
function failArgvError(e: ArgvError): never {
  const error: Record<string, unknown> = {
    code: "invalid_args",
    message: e.message,
  };
  if (e.hint !== undefined) error["hint"] = e.hint;
  process.stderr.write(JSON.stringify({ error }) + "\n");
  process.exit(1);
}
import { runCreate, createHelp } from "./commands/create.js";
import { runList, listHelp } from "./commands/list.js";
import { runState, stateHelp } from "./commands/state.js";
import { runSend, sendHelp } from "./commands/send.js";
import { runWatch, watchHelp } from "./commands/watch.js";
import { runDelete, deleteHelp } from "./commands/delete.js";
import { runParticipant, participantHelp } from "./commands/participant.js";
import { runShare, shareHelp } from "./commands/share.js";
import { runTemplate, artifactHelp } from "./commands/template.js";
import { runAgent, agentHelp } from "./commands/agent.js";
import { runKey, keyHelp } from "./commands/key.js";
import { runTaste, tasteHelp } from "./commands/taste.js";
import { runFeedback, feedbackHelp } from "./commands/feedback.js";
import { runConfig, configHelp } from "./commands/config.js";
import { runBlob, blobHelp } from "./commands/attachment.js";
import { runSkill, skillHelp } from "./commands/skill.js";
import { runRecords, recordsHelp } from "./commands/records.js";
import {
  runTemplateRecords,
  templateRecordsHelp,
} from "./commands/template-records.js";
import { runQuery, queryHelp } from "./commands/query.js";
import { runTrash, trashHelp } from "./commands/trash.js";
import { runDemo, demoHelp } from "./commands/demo.js";
import { VERSION } from "./version.js";
import { PaneApiError } from "@paneui/core";
import { failUpgradeRequired } from "./output.js";

const ROOT_HELP = `pane — a round-trip UI channel between agents and humans

Usage:
  pane <command> [options]

Pane commands (operate on the core noun — a live UI channel):
  create            Create a pane (POST /v1/panes). Prints pane_id, urls,
                    tokens, expires_at.
  list              Enumerate YOUR agent's panes.
  show <id>         Non-blocking snapshot: pane metadata + event log.
  send <id>         Emit an agent event into a pane.
  watch <id>        Stream a pane's events as JSON-lines on stdout.
  delete <id>       Close/delete a pane (DELETE /v1/panes/:id).
  participant       Manage participant URLs on an existing pane
    <list|new|revoke> (list | mint a fresh URL | revoke one URL).
  share <id>        Share a pane by identity: invite humans by email
                    (--email, with --role participant|viewer), set the /p
                    access mode (--mode invite-only|link|public, or the
                    aliases --public/--link/--invite-only), list grants
                    (--list), or revoke one (--revoke <grant-id>).

Other noun groups:
  demo              Take the 60-second guided tour — creates a tutorial pane,
                    opens it, and runs a live agent loop in your terminal.
                    Doubles as an end-to-end smoke test of your install.
  template          Reusable, versioned UI templates
                    (create | version | update | search | list | show | delete).
  template-records  Owner-curated content scoped to a Template head
                    (list | get | upsert | update | delete), visible to
                    every pane derived from any version of the template.
  key               YOUR agent's API key (list | revoke).
  taste             YOUR agent's freeform UI taste notes
                    (get | set | clear) — presentation preferences the agent
                    has learned from human feedback and reads before
                    generating a pane template.
  feedback          One-shot feedback to the relay operator
                    (create | list) — bug reports, feature requests, notes.
  attachment        Binary attachments (upload | download | show | list |
                    delete | token <mint|revoke|list>). Attachments are
                    scoped to an agent, a pane, or a template, and can be
                    referenced from event payloads + input_data via
                    \`format: pane-attachment-id\`.
  agent             Agent identity on this machine (register | logout).
  config            CLI config inspection (show).
  skill             The relay's SKILL.md (show | version) — auto-updating;
                    no API key required.
  trash             Manage soft-deleted panes / templates
                    (list | restore | restore-template | purge | purge-template).
  query             Run read-only SQL over your scoped panes / records /
                    events. JSON / CSV / TSV / table output.

Run \`pane <command> --help\` for command-specific options.

Config:
  PANE_URL          Relay base URL.        Override: --url <url>
  PANE_API_KEY      Agent API key.         Override: --api-key <key>
  PANE_PROFILE      Active profile name.   Override: --profile <name>
  'pane agent register' provisions the API key and saves it (with the URL) to
  \${XDG_CONFIG_HOME:-~/.config}/pane/config.json under a named profile —
  afterwards commands need no env vars. Manage multiple environments
  (dev/staging/prod) with 'pane config list / use / add / rm'.

Global flags:
  -h, --help        Show help.
  -v, --version     Print version.
  --profile <name>  Pick a saved profile for this invocation (overrides
                    PANE_PROFILE and the saved 'current_profile').
  --url <url>       Relay base URL — bypasses profile selection entirely.
  --api-key <key>   Agent API key — bypasses profile selection entirely.

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
// `pane template version` consume a value as a normal value-flag.
const BOOLEAN_FLAGS = new Set([
  "json",
  "once",
  "help",
  "print-key",
  "yes",
  "plain",
  // `pane demo --no-open`: skip the browser launch. Stored as the literal
  // `no-open` boolean (the parser does not auto-negate `--no-` prefixes).
  "no-open",
  // `pane share` access-mode aliases + list verb — registered here so the
  // parser treats them as flags, not value-flags that would swallow the next
  // token. (The full --mode <value> is a value-flag, handled in share.ts.)
  "public",
  "link",
  "invite-only",
  "list",
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
      failArgvError(e);
    }
    throw e;
  }

  const helps: Record<string, string> = {
    // Top-level pane verbs (formerly `pane surface <verb>` — see #163 follow-up).
    create: createHelp,
    list: listHelp,
    show: stateHelp,
    send: sendHelp,
    watch: watchHelp,
    delete: deleteHelp,
    participant: participantHelp,
    share: shareHelp,
    // Other noun groups.
    template: artifactHelp,
    key: keyHelp,
    taste: tasteHelp,
    feedback: feedbackHelp,
    attachment: blobHelp,
    agent: agentHelp,
    config: configHelp,
    skill: skillHelp,
    records: recordsHelp,
    "template-records": templateRecordsHelp,
    query: queryHelp,
    trash: trashHelp,
    demo: demoHelp,
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
  // --help is the responsibility of each runner (e.g. runPane dispatches to
  // the verb runner which reads its own xxxHelp). This pre-empt only fires
  // when --help is the FIRST positional-equivalent — i.e. no verb given.
  if (args.bools.has("help") && args.positionals.length === 0) {
    process.stdout.write(helps[noun]! + "\n");
    return;
  }

  switch (noun) {
    // Top-level pane verbs.
    case "create":
      await runCreate(args);
      break;
    case "list":
      await runList(args);
      break;
    case "show":
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
    case "participant":
      await runParticipant(args);
      break;
    case "share":
      await runShare(args);
      break;
    // Other noun groups.
    case "template":
      await runTemplate(args);
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
    case "attachment":
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
    case "records":
      await runRecords(args);
      break;
    case "template-records":
      await runTemplateRecords(args);
      break;
    case "query":
      await runQuery(args);
      break;
    case "trash":
      await runTrash(args);
      break;
    case "demo":
      await runDemo(args);
      break;
  }
}

main().catch((err) => {
  // ArgvError thrown from a runner (e.g. assertKnownFlags) reaches here —
  // funnel it through the same invalid_args envelope as the parse-time path
  // so unknown-flag rejection looks identical no matter which layer caught
  // the user error.
  if (err instanceof ArgvError) {
    failArgvError(err);
  }
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
