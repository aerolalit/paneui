// `pane session watch <id>` — long-lived: hold a WebSocket and stream events as
// JSON-lines on stdout. This harness-agnostic stdout is the core contract:
// one compact JSON object per line, flushed after every event, so any
// pipe-reader (Claude Code's Monitor tool, `while read line`, jq -c, ...)
// sees each event the instant it lands.

import { openStream, type PaneEvent } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { resolveConfig } from "../config.js";
import { PaneClient } from "@paneui/core";
import { printJsonLine, fail } from "../output.js";
import { VERSION } from "../version.js";

export const watchHelp = `pane session watch — stream a session's events as JSON-lines

Usage:
  pane session watch <session-id> [options]

Holds a WebSocket to WS /v1/sessions/:id/stream. Prints ONE compact JSON
object per line to stdout, flushing after each — designed to be piped into a
line-reader. On session close, prints a final {"type":"_closed"} line and
exits 0.

Modes:
  (bare)              Run until SIGINT (Ctrl-C). Exit 0.
  --once              Exit 0 after the first event.
  --type <t[,t2,…]>   Exit 0 after the first event whose type is in this
                      comma-separated set. Without --filter-type, stdout
                      still prints EVERY event until the match — --type
                      controls the EXIT condition, --filter-type controls
                      the OUTPUT.

Options:
  --filter-type <t[,t2,…]>
                      Print only events whose type is in this set.
                      system.* events (lifecycle: participant.joined,
                      session.expired, …) and the terminal {"type":
                      "_closed"} line always pass through, so the
                      harness still sees them. Combine with --type X
                      --filter-type X for "stream only X events and
                      exit on the first one" — the literal-reading of
                      --type alone that agents often expect.
  --since <cursor>    Replay only events after this opaque cursor.
  --timeout <secs>    Wall-clock max wait. Fail with code ws_timeout if
                      the natural exit condition (--once, --type, session
                      close) doesn't happen within this many seconds.
                      Frames arriving DO NOT reset the timer — this is
                      the budget for "give up on the human", not an idle
                      detector. Without --once or --type, bare watch
                      will simply exit non-zero at the deadline.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Each line is one event envelope: { id, session_id, author, ts, type, data,
causation_id, idempotency_key }. The terminal line is {"type":"_closed"}.

Pattern — Claude Code Monitor tool: run \`pane session watch <id> --type form.submitted\`
as a monitored process; the harness re-invokes the model when the line lands.

Wait for any of several events:
  pane session watch <id> --type form.submitted,form.cancelled --timeout 60

Stream only matching events to stdout, exit on the first:
  pane session watch <id> --type form.submitted --filter-type form.submitted`;

// Parse a comma-separated event-type list (e.g. "form.submitted,form.cancelled")
// into a Set. Empty/whitespace entries are dropped. Returns null when the flag
// wasn't given (so callers can distinguish "no filter" from "empty filter").
// Exported for unit-test coverage; the wrapper around the actual openStream
// integration is hard to test in isolation.
export function parseTypeList(raw: string | undefined): Set<string> | null {
  if (raw === undefined) return null;
  const types = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return new Set(types);
}

/**
 * Decide whether `--filter-type` lets this event through to stdout. Lifecycle
 * `system.*` events always pass — without that an agent waiting on
 * `--filter-type form.submitted` would never see `system.participant.joined`
 * and miss the "the human opened the URL" signal. Exported for testing.
 */
export function shouldPrintEvent(
  eventType: string,
  filterTypes: Set<string> | null,
): boolean {
  if (filterTypes === null) return true;
  if (eventType.startsWith("system.")) return true;
  return filterTypes.has(eventType);
}

export async function runWatch(args: ParsedArgs): Promise<void> {
  const sessionId = args.positionals[0];
  if (!sessionId) fail("missing <session-id>", "invalid_args");

  const cfg = resolveConfig(args);
  const since = args.flags.get("since") ?? null;
  // --type controls the EXIT condition (set of types that trigger exit 0
  // on first match). --filter-type controls OUTPUT (the only event types
  // printed to stdout; system.* and _closed always pass through). Each
  // flag is independent — combine them only if you really want both.
  const exitTypes = parseTypeList(args.flags.get("type"));
  const filterTypes = parseTypeList(args.flags.get("filter-type"));
  const once = args.bools.has("once");

  let timeoutSec: number | null = null;
  const timeoutRaw = args.flags.get("timeout");
  if (timeoutRaw !== undefined) {
    const t = Number(timeoutRaw);
    if (!Number.isFinite(t) || t <= 0)
      fail("--timeout must be a positive number", "invalid_args");
    timeoutSec = t;
  }

  const client = new PaneClient({
    url: cfg.url,
    apiKey: cfg.apiKey,
    cliVersion: VERSION,
  });

  let exited = false;
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    if (timer) clearTimeout(timer);
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

  // Track whether the relay told us the session expired before the socket
  // closed — a 1006/1008/1011 close after that is still a clean shutdown.
  let sawSessionExpired = false;

  // Wall-clock timeout. The reporter's mental model (#137) and the skill
  // text both treat this as "max wait until something happens" — i.e. an
  // agent giving up on a human who never acts. The previous behaviour
  // (clear the timer on first frame, never re-arm) made `--timeout`
  // useless once any frame arrived, even a system.participant.joined
  // emitted the moment a human connected. Frames now DO NOT reset the
  // timer; the only ways `--timeout` doesn't fire are the natural exit
  // conditions (--once, --type match, session close) finishing first.
  let timer: NodeJS.Timeout | undefined;
  if (timeoutSec !== null) {
    timer = setTimeout(() => {
      fail(`no terminal condition met within ${timeoutSec}s`, "ws_timeout");
    }, timeoutSec * 1000);
  }

  const handle = openStream(
    {
      wsBaseUrl: client.wsBaseUrl,
      sessionId: sessionId!,
      token: cfg.apiKey,
      since,
    },
    {
      onReplayComplete: () => {
        // No-op: replay-complete is informational, no timer interaction.
      },
      onEvent: (event: PaneEvent) => {
        // Output filter: print only events the agent asked for. See
        // shouldPrintEvent — system.* lifecycle events always pass.
        if (shouldPrintEvent(event.type, filterTypes)) {
          printJsonLine(event);
        }
        // A system.session.expired event means the session is closing.
        if (event.type === "system.session.expired") {
          sawSessionExpired = true;
          emitClosed();
          return;
        }
        if (once) {
          finish(0);
          return;
        }
        if (exitTypes !== null && exitTypes.has(event.type)) {
          finish(0);
        }
      },
      onClose: ({ code, reason }) => {
        // A clean close is 1000 (normal) or 1001 (going away). Any other code
        // — 1006 abnormal, 1008 policy/auth, 1011 server error — is a failure
        // UNLESS we already saw system.session.expired, which means the relay
        // closed us on purpose after a clean session end.
        if (code === 1000 || code === 1001 || sawSessionExpired) {
          emitClosed();
          return;
        }
        fail(
          `stream closed abnormally (code ${code})${reason ? ": " + reason : ""}`,
          "ws_closed_abnormally",
          { code, reason },
        );
      },
      onRelayError: (err) => {
        fail(
          err.message ?? "relay error",
          err.code ?? "relay_error",
          err.details,
        );
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
