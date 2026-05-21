// Tests for `pane session` — the noun-level dispatcher.
//
// The verb runners (runCreate / runState / runSend / runWatch / runDelete)
// have their own tests against the sliced ParsedArgs shape they expect. This
// file pins what the *dispatcher* does: peels off the verb positional and
// forwards a ParsedArgs whose positionals[0] is the session id (not the verb).
// Errors out cleanly on missing / unknown verbs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// runDelete is the simplest verb runner to exercise here: it reads
// positionals[0] as the session id and calls client.deleteSession. By
// stubbing makeClient and watching the recorded id we can prove the
// dispatcher's slice did the right thing.
const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  deleteSession: vi.fn((id: unknown) => {
    calls.push({ method: "deleteSession", args: [id] });
    return Promise.resolve();
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runSession } from "./session.js";
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
    await runSession(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runSession dispatch", () => {
  it("rejects a missing verb", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr).error as { code: string; message: string };
    expect(err.code).toBe("invalid_args");
    expect(err.message).toContain("missing verb");
  });

  it("rejects an unknown verb", async () => {
    await run(["frobnicate"]);
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr).error as { code: string; message: string };
    expect(err.code).toBe("invalid_args");
    expect(err.message).toContain("unknown session verb");
  });

  it("forwards `delete <id>` to runDelete with positionals[0] = id", async () => {
    // The dispatcher's contract: peel the verb off the front, leaving the
    // session id at positionals[0] for runDelete. If we got the slice
    // wrong, runDelete would either see "delete" as the id or undefined
    // and fail with "missing <session-id>".
    await run(["delete", "ses_abc"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([{ method: "deleteSession", args: ["ses_abc"] }]);
  });

  it("propagates missing-id errors from the verb runner", async () => {
    // `pane session delete` with no id should surface runDelete's own
    // "missing <session-id>" — the dispatcher must not swallow it.
    await run(["delete"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <session-id>");
  });
});
