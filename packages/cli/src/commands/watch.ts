// `pane watch <id>` — long-lived: hold a WebSocket and stream events as
// JSON-lines on stdout. This harness-agnostic stdout is the core contract:
// one compact JSON object per line, flushed after every event, so any
// pipe-reader (Claude Code's Monitor tool, `while read line`, jq -c, ...)
// sees each event the instant it lands.

import { openStream, type PaneEvent } from "@pane/core";
import type { ParsedArgs } from "../argv.js";
import { resolveConfig } from "../config.js";
import { PaneClient } from "@pane/core";
import { printJsonLine, fail } from "../output.js";

export const watchHelp = `pane watch — stream a session's events as JSON-lines

Usage:
  pane watch <session-id> [options]

Holds a WebSocket to WS /v1/sessions/:id/stream. Prints ONE compact JSON
object per line to stdout, flushing after each — designed to be piped into a
line-reader. On session close, prints a final {"type":"_closed"} line and
exits 0.

Modes:
  (bare)              Run until SIGINT (Ctrl-C). Exit 0.
  --once              Exit 0 after the first event.
  --type <t>          Exit 0 after the first event whose type equals <t>.

Options:
  --since <cursor>    Replay only events after this opaque cursor.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  --json              Output JSON-lines (default; the only mode).
  -h, --help          Show this help.

Each line is one event envelope: { id, session_id, author, ts, type, data,
causation_id, idempotency_key }. The terminal line is {"type":"_closed"}.

Pattern — Claude Code Monitor tool: run \`pane watch <id> --type form.submitted\`
as a monitored process; the harness re-invokes the model when the line lands.`;

export async function runWatch(args: ParsedArgs): Promise<void> {
  const sessionId = args.positionals[0];
  if (!sessionId) fail("missing <session-id>", "invalid_args");

  const cfg = resolveConfig(args);
  const since = args.flags.get("since") ?? null;
  const waitType = args.flags.get("type") ?? null;
  const once = args.bools.has("once");

  const client = new PaneClient({ url: cfg.url, apiKey: cfg.apiKey });

  let exited = false;
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };

  // Emit the terminal marker exactly once, then exit 0.
  let closedEmitted = false;
  const emitClosed = (): void => {
    if (!closedEmitted) {
      closedEmitted = true;
      printJsonLine({ type: "_closed" });
    }
    finish(0);
  };

  const handle = openStream(
    { wsBaseUrl: client.wsBaseUrl, sessionId: sessionId!, token: cfg.apiKey, since },
    {
      onEvent: (event: PaneEvent) => {
        printJsonLine(event);
        // A system.session.expired event means the session is closing.
        if (event.type === "system.session.expired") {
          emitClosed();
          return;
        }
        if (once) {
          finish(0);
          return;
        }
        if (waitType !== null && event.type === waitType) {
          finish(0);
        }
      },
      onClose: () => {
        // Socket closed (session gone, relay restart, etc.) — terminal.
        emitClosed();
      },
      onRelayError: (err) => {
        fail(err.message ?? "relay error", err.code ?? "relay_error", err.details);
      },
      onError: (err) => {
        fail(err.message, "ws_error");
      },
    },
  );

  // SIGINT: clean shutdown, exit 0.
  process.on("SIGINT", () => {
    handle.close();
    finish(0);
  });
}
