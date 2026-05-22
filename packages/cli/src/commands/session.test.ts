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
  listSessions: vi.fn((opts: unknown) => {
    calls.push({ method: "listSessions", args: [opts] });
    return Promise.resolve({ items: [], next_cursor: null });
  }),
  mintParticipant: vi.fn((sessionId: unknown, opts: unknown) => {
    calls.push({ method: "mintParticipant", args: [sessionId, opts] });
    return Promise.resolve({
      participant_id: "p_new",
      kind: "human",
      token: "tok_h_x",
      url: "http://r/s/tok_h_x",
      created_at: "2026-05-21T00:00:00.000Z",
    });
  }),
  revokeParticipant: vi.fn((sessionId: unknown, participantId: unknown) => {
    calls.push({
      method: "revokeParticipant",
      args: [sessionId, participantId],
    });
    return Promise.resolve();
  }),
  listParticipants: vi.fn((sessionId: unknown) => {
    calls.push({ method: "listParticipants", args: [sessionId] });
    return Promise.resolve({ session_id: sessionId, items: [] });
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

describe("runSession list", () => {
  it("forwards `list` to runList with no opts by default", async () => {
    await run(["list"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([{ method: "listSessions", args: [{}] }]);
  });

  it("forwards --status / --limit / --cursor / --artifact-id", async () => {
    await run([
      "list",
      "--status",
      "all",
      "--limit",
      "25",
      "--cursor",
      "opaque",
      "--artifact-id",
      "art_xyz",
    ]);
    expect(calls[0]!.args[0]).toEqual({
      status: "all",
      limit: 25,
      cursor: "opaque",
      artifact_id: "art_xyz",
    });
  });

  it("rejects an unknown --status before the network call", async () => {
    await run(["list", "--status", "purple"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("rejects --limit out of 1..200", async () => {
    await run(["list", "--limit", "0"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);

    stderr = "";
    exitCode = undefined;
    await run(["list", "--limit", "201"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe("runSession participant", () => {
  it("lists the participants on the given session", async () => {
    await run(["participant", "list", "ses_abc"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([{ method: "listParticipants", args: ["ses_abc"] }]);
  });

  it("mints a fresh URL on the given session", async () => {
    await run(["participant", "new", "ses_abc"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      { method: "mintParticipant", args: ["ses_abc", undefined] },
    ]);
  });

  it("revokes the given (session-id, participant-id) pair", async () => {
    await run(["participant", "revoke", "ses_abc", "p_xyz"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toEqual([
      { method: "revokeParticipant", args: ["ses_abc", "p_xyz"] },
    ]);
  });

  it("rejects an unknown participant verb", async () => {
    await run(["participant", "frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown participant verb");
    expect(calls).toHaveLength(0);
  });

  it("rejects missing participant verb", async () => {
    await run(["participant"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing verb");
    expect(calls).toHaveLength(0);
  });

  it("fails with a clear error when 'list' is missing <session-id>", async () => {
    await run(["participant", "list"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <session-id>");
    expect(calls).toHaveLength(0);
  });

  it("fails with a clear error when 'new' is missing <session-id>", async () => {
    await run(["participant", "new"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing <session-id>");
    expect(calls).toHaveLength(0);
  });

  it("fails when 'revoke' is missing <participant-id>", async () => {
    await run(["participant", "revoke", "ses_abc"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing arguments");
    expect(calls).toHaveLength(0);
  });
});
