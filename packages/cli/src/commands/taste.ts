// `pane taste` — read / write / clear the calling agent's freeform "taste
// notes" markdown blob.
//
// Taste notes are presentation preferences the agent has learned from human
// feedback ("denser layout", "no rounded corners", "use a dark header") — the
// kind of guidance that should outlive a single session. The intended loop:
//
//   1. Before generating a pane artifact, run `pane taste get` and feed the
//      `taste` field into the prompt so prior preferences shape the output.
//   2. When the human gives new presentation feedback, run `pane taste get`,
//      merge the feedback into the existing notes IN THE PROMPT, then call
//      `pane taste set` with the WHOLE new blob (the relay does whole-blob
//      replace, not append — that's deliberate, so the notes can't grow
//      unbounded into noise).
//
// Keep taste notes about *presentation/UI taste only* — colours, density,
// component preferences. Project context, todos, and per-session state belong
// somewhere else. Today the blob is keyed by the agent's API key (per-agent);
// when pane gains first-class humans, this may move to per-human.

import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

export const tasteHelp = `pane taste — read / write / clear YOUR agent's UI taste notes

Taste notes are a small markdown blob storing presentation preferences your
agent has picked up from human feedback ("denser table", "no rounded corners",
"use a dark header"). Read them before generating a pane artifact so prior
feedback shapes the output; rewrite them whenever the human gives new
presentation feedback. Keep entries about UI/presentation taste only — not
project context, todos, or session state.

Usage:
  pane taste <subcommand> [options]

Subcommands:
  get        Print the current notes blob:
             { taste: string|null, updated_at: string|null, bytes: number }.
             taste is null and bytes is 0 when notes have never been written.

  set        Whole-blob replace. Source the markdown via --file <path>,
             --file - (read stdin), or by piping into 'pane taste set' with
             no flag. The relay rejects empty/whitespace-only payloads and
             caps the blob at MAX_TASTE_BYTES (utf8). To clear the notes,
             use 'pane taste clear', not 'set' with an empty body.

  clear      Delete the notes. Requires --yes (it is destructive). Prints
             { cleared: true }.

Options:
  --file <path|->     Source for 'set' — a file path, or '-' to read stdin
                      explicitly. Omit to fall back to piped stdin.
  --yes               Confirm 'clear'.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Examples:
  pane taste get
  pane taste set --file ./taste.md
  pane taste set --file -            # explicit stdin
  echo "- denser layout" | pane taste set
  pane taste clear --yes

Output: stdout is machine-readable JSON.`;

// Drain process.stdin to a utf8 string. The caller is responsible for
// deciding that stdin should be read (e.g. an explicit `--file -`, or a
// non-TTY stdin where data is actually piped). In a TTY this would block
// waiting for ^D, so the caller MUST gate on `process.stdin.isTTY` first.
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runTasteGet(args: ParsedArgs): Promise<void> {
  const client = makeClient(args);
  try {
    const info = await client.getTaste();
    printJson(info);
  } catch (e) {
    failFromError(e);
  }
}

async function runTasteSet(args: ParsedArgs): Promise<void> {
  const filePath = args.flags.get("file");

  // Source the blob deterministically — no isTTY-flag fusing, because
  // `!process.stdin.isTTY` is true under every non-interactive caller
  // (pipes, redirects, closed fd, CI, agent harnesses) and would wrongly
  // reject `--file` for the entire target audience. See issue #148.
  //
  //   --file -        → explicit stdin sentinel
  //   --file <path>   → read that path (works in TTY and non-TTY alike)
  //   (no --file)     → fall back to stdin IF non-TTY; error in a TTY
  let taste: string;
  if (filePath === "-") {
    taste = await readStdin();
  } else if (filePath !== undefined) {
    try {
      taste = readFileSync(filePath, "utf8");
    } catch (e) {
      fail(
        `failed to read --file '${filePath}': ${e instanceof Error ? e.message : String(e)}`,
        "invalid_args",
      );
    }
  } else if (!process.stdin.isTTY) {
    taste = await readStdin();
  } else {
    fail(
      "'pane taste set' needs input — pass --file <path>, pipe markdown on stdin, or use --file -",
      "invalid_args",
    );
  }

  if (taste.trim().length === 0) {
    fail(
      "'pane taste set' refuses an empty or whitespace-only blob — use 'pane taste clear --yes' to delete the notes",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    const info = await client.setTaste(taste);
    printJson(info);
  } catch (e) {
    failFromError(e);
  }
}

async function runTasteClear(args: ParsedArgs): Promise<void> {
  if (!args.bools.has("yes")) {
    fail(
      "'pane taste clear' deletes YOUR agent's taste notes — it is destructive. Pass --yes to confirm.",
      "confirmation_required",
    );
  }

  const client = makeClient(args);
  try {
    await client.clearTaste();
    printJson({ cleared: true });
  } catch (e) {
    failFromError(e);
  }
}

export async function runTaste(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "get":
      await runTasteGet(args);
      break;
    case "set":
      await runTasteSet(args);
      break;
    case "clear":
      await runTasteClear(args);
      break;
    case undefined:
      fail(
        "missing subcommand — usage: pane taste <get|set|clear> (run 'pane taste --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown taste subcommand '${sub}' — expected get|set|clear (run 'pane taste --help')`,
        "invalid_args",
      );
  }
}
