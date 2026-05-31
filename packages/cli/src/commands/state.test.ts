// Tests for `pane surface show` — dispatch + the --wait long-poll option.
//
// Pins the contract that #137's follow-up introduced: --wait <secs> is
// passed through to the relay's GET /v1/surfaces/:id/events?wait=<secs>
// so headless polling agents (cron, FaaS, no-WS environments) can poll
// efficiently without holding a WebSocket open.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  getSession: vi.fn((id: unknown) => {
    calls.push({ method: "getSession", args: [id] });
    return Promise.resolve({ id });
  }),
  getEvents: vi.fn((id: unknown, opts: unknown) => {
    calls.push({ method: "getEvents", args: [id, opts] });
    return Promise.resolve({ events: [], next_cursor: null });
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runState } from "./state.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key", "yes"]);
function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  calls.length = 0;
  stderr = "";
  exitCode = undefined;
  // stdout is captured but unread by the assertions here — only the
  // recorded fake-client calls and stderr/exit are inspected. Spying
  // keeps the test output clean.
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += String(s);
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runState(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("pane surface show", () => {
  it("fetches meta + events without --wait (non-blocking, default behaviour)", async () => {
    await run(["sur_abc"]);
    expect(exitCode).toBeUndefined();
    expect(calls[0]!.method).toBe("getSession");
    expect(calls[1]!.method).toBe("getEvents");
    // No waitSeconds in the opts when --wait wasn't given. We deliberately
    // OMIT the field rather than send 0, so the relay's defaults and the
    // CLI's snapshot semantics stay aligned.
    const opts = calls[1]!.args[1] as {
      since: string | null;
      waitSeconds?: number;
    };
    expect(opts.since).toBeNull();
    expect(opts.waitSeconds).toBeUndefined();
  });

  it("passes --since through verbatim", async () => {
    await run(["sur_abc", "--since", "42"]);
    const opts = calls[1]!.args[1] as { since: string | null };
    expect(opts.since).toBe("42");
  });

  it("passes --wait through as waitSeconds (long-poll)", async () => {
    // The relay caps the wait at 30s server-side; we pass the raw value
    // and don't clamp client-side (cheaper, and lets the operator change
    // the cap without coordinating a CLI release).
    await run(["sur_abc", "--wait", "30"]);
    const opts = calls[1]!.args[1] as { waitSeconds?: number };
    expect(opts.waitSeconds).toBe(30);
  });

  it("rejects --wait with a negative or non-numeric value", async () => {
    await run(["sur_abc", "--wait", "-1"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--wait");
    // No relay call should have fired — the parser rejects before the
    // network hop.
    expect(calls).toHaveLength(0);
  });

  it("missing surface-id is invalid_args, no relay call", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <surface-id>");
    expect(calls).toHaveLength(0);
  });
});
