// `pane demo` — a self-teaching tutorial pane.
//
// One command: create a pane with the bundled tutorial artifact, open (or
// print) its URL, then run a tiny built-in agent loop in this same process
// that watches the session and reacts to each human interaction with the
// matching agent event. Every received event is echoed to the terminal as it
// lands, so the user sees their click in BOTH places — the pane redraws AND
// their terminal prints the same event. That round-trip IS the lesson, and a
// successful demo doubles as an end-to-end smoke test of the install (auth,
// relay reachability, WebSocket, a real event round-trip).
//
// Run-to-completion: the loop walks Scenes 1-6, sends demo.done, prints the
// "build your own" snippet, and exits 0. The pane is created with a short TTL
// (the relay's sweeper reclaims it) and best-effort DELETEd on exit.

import {
  openStream,
  PaneClient,
  type PaneEvent,
  type StreamHandle,
} from "@paneui/core";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { resolveConfig } from "../config.js";
import { fail, failFromError } from "../output.js";
import { VERSION } from "../version.js";
import {
  DEMO_ARTIFACT_HTML,
  DEMO_EVENT_SCHEMA,
  DEMO_TEMPLATE_NAME,
  DEMO_TITLE,
} from "./demo-artifact.js";

const KNOWN_FLAGS = ["ttl"];
// --no-open is the documented spelling; the parser stores it as the boolean
// flag "no-open" (a leading `--no-` is NOT auto-negated by this CLI's parser,
// so we read the literal flag name).
const KNOWN_BOOLS = ["no-open", "json"];

// The default pane TTL for the demo: long enough to read through the tour at a
// relaxed pace, short enough that an abandoned demo is reclaimed promptly. The
// relay clamps this to its own MAX_TTL_SECONDS regardless.
const DEMO_TTL_SECONDS = 900;

export const demoHelp = `pane demo — take the 60-second guided tour

Usage:
  pane demo [options]

Creates a short-lived pane with the built-in tutorial artifact, opens its URL
in your browser (or prints it if none is available), then runs a tiny agent
loop right here in your terminal that watches the session and reacts to each
thing you do in the pane. Every event you trigger is echoed to this terminal
as it arrives — so you see your click land in BOTH places at once.

It's also a full smoke test: if your install is healthy, the tour completes;
if auth, the relay, or the WebSocket is broken, it fails loudly at the exact
step that's wrong.

The loop runs to completion (Scenes 1-6), then prints a "build your own"
snippet and exits 0. The demo pane is created with a short TTL and deleted on
exit.

Options:
  --ttl <seconds>   Demo pane time-to-live (default ${DEMO_TTL_SECONDS}). The relay
                    clamps to its configured maximum.
  --no-open         Don't try to open a browser — just print the URL. Implied
                    on headless / SSH sessions where no opener is found.
  --url <url>       Relay base URL (overrides PANE_URL).
  --api-key <key>   Agent API key (overrides PANE_API_KEY).
  -h, --help        Show this help.

Run it right after 'pane agent register' to confirm everything works.`;

/**
 * The built-in demo agent's reaction table. Given a HUMAN event type, return
 * the sequence of agent events the loop should emit in response. Pure and
 * synchronous so it can be unit-tested against a scripted event sequence
 * without a relay. Each reaction carries an optional `delayMs` so the
 * conclusion (Scenes 5-6) plays as a short narrated beat rather than three
 * frames in the same tick.
 *
 * Mapping (see the scene spec in demo-artifact.ts):
 *   demo.start -> demo.advance{scene:2}            (show the model)
 *   demo.hello -> demo.advance{scene:3, note}      (the proof beat)
 *   demo.form  -> demo.echo{received},             (reflect the payload)
 *                 demo.advance{scene:5},           (the event log)
 *                 demo.done                        (the CTA)
 *
 * Any other (or agent-authored) event yields no reaction.
 */
export interface AgentReaction {
  type: "demo.advance" | "demo.echo" | "demo.done";
  data: Record<string, unknown>;
  /** Milliseconds to wait before emitting this reaction (default 0). */
  delayMs?: number;
}

export function demoReactions(
  humanEventType: string,
  humanData?: unknown,
): AgentReaction[] {
  switch (humanEventType) {
    case "demo.start":
      return [{ type: "demo.advance", data: { scene: 2 } }];
    case "demo.hello":
      return [
        {
          type: "demo.advance",
          data: {
            scene: 3,
            note: "received your click — printed in your terminal",
          },
        },
      ];
    case "demo.form": {
      const received =
        humanData && typeof humanData === "object"
          ? (humanData as Record<string, unknown>)
          : {};
      return [
        { type: "demo.echo", data: { received } },
        { type: "demo.advance", data: { scene: 5 }, delayMs: 1200 },
        { type: "demo.done", data: {}, delayMs: 2400 },
      ];
    }
    default:
      return [];
  }
}

/** The human event types the demo loop reacts to (its terminal one is demo.form). */
const HUMAN_EVENT_TYPES = new Set(["demo.start", "demo.hello", "demo.form"]);

/** The "build your own" snippet printed on completion. */
function buildYourOwnSnippet(): string {
  return [
    "",
    "That's the round-trip. To hand your own UI to a human:",
    "",
    "  pane create \\",
    '    --template ./form.html --name "My form" \\',
    "    --event-schema ./schema.json",
    "  pane watch <id> --type form.submitted",
    "",
    "Full guide:  pane skill show",
    "Docs:        https://paneui.com",
    "",
  ].join("\n");
}

/**
 * Best-effort open a URL in the user's default browser. Returns true if an
 * opener was spawned, false if none is available (headless / unknown platform)
 * or the spawn failed. Never throws — the tour works headless either way.
 */
export function openInBrowser(url: string): boolean {
  // No env-var gating here: on headless / CI boxes the platform opener simply
  // isn't installed (or errors), the spawn failure is swallowed below, and the
  // caller falls back to printing the URL. (`--no-open` is handled upstream.)
  const p = platform();
  let cmd: string;
  let args: string[];
  if (p === "darwin") {
    cmd = "open";
    args = [url];
  } else if (p === "win32") {
    // `start` is a cmd builtin; the empty "" is the (ignored) window title.
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    // Linux / BSD: xdg-open is the de-facto opener. On a headless box it
    // won't exist; the spawn error is swallowed and we fall back to print.
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    let failed = false;
    child.on("error", () => {
      failed = true;
    });
    child.unref();
    // `spawn` reports a missing binary asynchronously via the 'error' event,
    // so we can't know synchronously whether xdg-open exists. We optimistically
    // report true; the printed URL below is always shown regardless, so a
    // silent opener failure still leaves the user a working link.
    return !failed;
  } catch {
    return false;
  }
}

export async function runDemo(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane demo");

  let ttl = DEMO_TTL_SECONDS;
  const ttlRaw = args.flags.get("ttl");
  if (ttlRaw !== undefined) {
    const t = Number(ttlRaw);
    if (!Number.isInteger(t) || t <= 0) {
      fail("--ttl must be a positive integer", "invalid_args");
    }
    ttl = t;
  }

  // Resolve config once and build the client from it — the agent loop below
  // needs the API key directly (for the WS token), and makeClient would
  // re-resolve the same config (extra disk read + parse) to no benefit.
  const cfg = resolveConfig(args);
  const client = new PaneClient({
    url: cfg.url,
    apiKey: cfg.apiKey,
    cliVersion: VERSION,
  });

  // 1. Create the demo pane with the bundled artifact + its event schema.
  let created;
  try {
    created = await client.createPane({
      template: {
        name: DEMO_TEMPLATE_NAME,
        type: "html-inline",
        source: DEMO_ARTIFACT_HTML,
        event_schema: DEMO_EVENT_SCHEMA,
      },
      title: DEMO_TITLE,
      ttl,
      participants: { humans: 1 },
    });
  } catch (e) {
    failFromError(e);
  }

  const paneId = created.pane_id;
  const humanUrl = created.urls.humans[0];

  // 2. Open (or print) the URL. The loop runs either way, so headless / SSH
  //    works — we just skip the browser launch.
  const wantOpen = !args.bools.has("no-open");
  const out = process.stdout;
  out.write(`\nPane demo — your 60-second tour is ready.\n\n`);
  if (humanUrl) {
    out.write(`  ${humanUrl}\n\n`);
    if (wantOpen && openInBrowser(humanUrl)) {
      out.write(`Opening it in your browser…\n`);
    } else {
      out.write(`Open this link to start the tour.\n`);
    }
  } else {
    out.write(`(No human URL was minted — check your relay configuration.)\n`);
  }
  out.write(
    `\nWatching the pane — your clicks will print here as they land:\n\n`,
  );

  // 3. Run the agent loop: watch the stream, react to each human event,
  //    echo every received event to the terminal, and finish on demo.done.
  await runDemoLoop({
    wsBaseUrl: client.wsBaseUrl,
    paneId,
    token: cfg.apiKey,
    sendEvent: (type, data) =>
      client.sendEvent(paneId, { type, data }).then(() => undefined),
    deletePane: () => client.deletePane(paneId).catch(() => undefined),
    write: (s) => {
      out.write(s);
    },
  });
}

/**
 * Drive the demo to completion over an open stream. Factored out of runDemo so
 * the wiring (stream open/close, reaction dispatch, terminal echo, cleanup) is
 * exercised independently of pane-create. Resolves once demo.done has been
 * emitted (or the stream closes / errors), after best-effort deleting the pane.
 */
export interface DemoLoopDeps {
  wsBaseUrl: string;
  paneId: string;
  token: string;
  sendEvent: (type: string, data: Record<string, unknown>) => Promise<void>;
  deletePane: () => Promise<void>;
  write: (s: string) => void;
  /** Test seam: replace setTimeout so reaction delays don't slow the suite. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Test seam: open the stream (defaults to the real openStream). */
  openStreamImpl?: typeof openStream;
}

export function runDemoLoop(deps: DemoLoopDeps): Promise<void> {
  const schedule =
    deps.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  const open = deps.openStreamImpl ?? openStream;

  return new Promise<void>((resolve) => {
    let settled = false;
    // Late-bound so `finish` (defined before the stream is opened) can close
    // it; `open()` returns synchronously below and every handler that calls
    // `finish` fires asynchronously, so the binding is always set by then.
    const ref: { handle?: StreamHandle } = {};
    // Track whether demo.done was actually sent, so an early stream close
    // (TTL / human shut the tab) is reported as "before completion" rather
    // than a successful finish.
    let doneSent = false;

    const finish = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      try {
        ref.handle?.close();
      } catch {
        /* ignore */
      }
      await deps.deletePane();
      resolve();
    };

    // Dispatch a single agent reaction, honouring its delay. demo.done is the
    // terminal event — once it's been emitted we wrap up.
    const dispatch = (r: ReturnType<typeof demoReactions>[number]): void => {
      const send = (): void => {
        if (settled) return;
        deps
          .sendEvent(r.type, r.data)
          .then(() => {
            if (r.type === "demo.done") {
              doneSent = true;
              deps.write(buildYourOwnSnippet());
              void finish();
            }
          })
          .catch((e: unknown) => {
            deps.write(
              `\n[demo] failed to send ${r.type}: ${
                e instanceof Error ? e.message : String(e)
              }\n`,
            );
            void finish();
          });
      };
      if (r.delayMs && r.delayMs > 0) schedule(send, r.delayMs);
      else send();
    };

    ref.handle = open(
      { wsBaseUrl: deps.wsBaseUrl, paneId: deps.paneId, token: deps.token },
      {
        onEvent: (event: PaneEvent) => {
          if (settled) return;
          // Only react to (and echo) the human's own interactions. The agent's
          // own replies stream back too — echoing those would double-print and
          // re-trigger reactions.
          if (!HUMAN_EVENT_TYPES.has(event.type)) return;
          deps.write(
            `  ← ${event.type}  ${JSON.stringify(event.data ?? {})}\n`,
          );
          for (const r of demoReactions(event.type, event.data)) dispatch(r);
        },
        onClose: () => {
          // If the pane closed before demo.done (e.g. TTL or the human shut the
          // tab), still resolve cleanly — the loop is run-to-completion but a
          // dropped human is a valid end, not a crash.
          if (!doneSent) {
            deps.write(`\n[demo] session closed before completion.\n`);
          }
          void finish();
        },
        onRelayError: (err) => {
          deps.write(
            `\n[demo] relay error: ${err.message ?? err.code ?? "unknown"}\n`,
          );
          void finish();
        },
        onError: (err) => {
          deps.write(`\n[demo] stream error: ${err.message}\n`);
          void finish();
        },
      },
    );
  });
}
