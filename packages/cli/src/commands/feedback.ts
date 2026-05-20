import type { FeedbackType } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

export const feedbackHelp = `pane feedback — submit / list feedback to the relay operator

Feedback is a one-shot bug report, feature request, or note from YOUR agent
to whoever runs the relay. Submissions are stored in the relay DB; the
operator triages out of band.

Usage:
  pane feedback <subcommand> [options]

Subcommands:
  create     Submit one feedback row. Requires --type and --message.
             Prints { id, type, created_at } — the message is not echoed back.

  list       List YOUR agent's own submissions, newest first. Prints
             { items: [...], next_before?: <cursor> }. Pass --before <cursor>
             from a previous page to fetch the next page.

Options for 'create':
  --type <bug|feature|note>   Feedback category. Required.
  --message <text|->          Message body. Pass '-' to read from stdin.
                              1..4000 chars after trim.
  --session-id <id>           Optional session this feedback relates to;
                              must belong to YOUR agent.

Options for 'list':
  --limit <N>                 Page size (default 50, max 100).
  --before <cursor>           Opaque cursor from a previous page's next_before.

Global:
  --url <url>                 Relay base URL (overrides PANE_URL).
  --api-key <key>             Agent API key (overrides PANE_API_KEY).
  -h, --help                  Show this help.

Examples:
  pane feedback create --type bug --message "watch hangs on empty session"
  echo "long-form note..." | pane feedback create --type note --message -
  pane feedback list --limit 20

Output: stdout is machine-readable JSON.`;

const FEEDBACK_TYPES: readonly FeedbackType[] = ["bug", "feature", "note"];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runFeedbackCreate(args: ParsedArgs): Promise<void> {
  const type = args.flags.get("type");
  const rawMessage = args.flags.get("message");
  const sessionId = args.flags.get("session-id");

  if (type === undefined) {
    fail(
      "'pane feedback create' requires --type <bug|feature|note>",
      "invalid_args",
    );
  }
  if (!FEEDBACK_TYPES.includes(type as FeedbackType)) {
    fail(
      `unknown --type '${type}' — expected one of: ${FEEDBACK_TYPES.join(", ")}`,
      "invalid_args",
    );
  }
  if (rawMessage === undefined) {
    fail(
      "'pane feedback create' requires --message <text|-> (use '-' to read from stdin)",
      "invalid_args",
    );
  }

  let message: string;
  if (rawMessage === "-") {
    if (process.stdin.isTTY) {
      fail(
        "'pane feedback create --message -' expects feedback on stdin, but stdin is a TTY",
        "invalid_args",
      );
    }
    message = await readStdin();
  } else {
    message = rawMessage;
  }

  if (message.trim().length === 0) {
    fail(
      "feedback message must not be empty or whitespace-only",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    const res = await client.submitFeedback({
      type: type as FeedbackType,
      message,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

async function runFeedbackList(args: ParsedArgs): Promise<void> {
  const limitRaw = args.flags.get("limit");
  const before = args.flags.get("before");

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) {
      fail(
        `--limit must be a positive integer, got '${limitRaw}'`,
        "invalid_args",
      );
    }
    limit = n;
  }

  const client = makeClient(args);
  try {
    const page = await client.listFeedback({
      ...(limit !== undefined ? { limit } : {}),
      ...(before !== undefined ? { before } : {}),
    });
    printJson(page);
  } catch (e) {
    failFromError(e);
  }
}

export async function runFeedback(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "create":
      await runFeedbackCreate(args);
      break;
    case "list":
      await runFeedbackList(args);
      break;
    case undefined:
      fail(
        "missing subcommand — usage: pane feedback <create|list> (run 'pane feedback --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown feedback subcommand '${sub}' — expected create|list (run 'pane feedback --help')`,
        "invalid_args",
      );
  }
}
