// Tests for `pane participant new|revoke` — subcommand dispatch and missing-
// argument handling.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  mintParticipant: vi.fn((sessionId: unknown, opts: unknown) => {
    calls.push({ method: "mintParticipant", args: [sessionId, opts] });
    return Promise.resolve({
      participant_id: "p_new",
      kind: "human",
      token: "tok_h_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      url: "http://relay.example.com/s/tok_h_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
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
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runParticipant } from "./participant.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key", "yes"]);

function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let stdout: string;
let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  calls.length = 0;
  stdout = "";
  stderr = "";
  exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += s;
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += s;
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
    await runParticipant(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runParticipant new", () => {
  it("mints on the given session and prints the response", async () => {
    await run(["new", "ses_abc"]);
    expect(calls).toEqual([
      { method: "mintParticipant", args: ["ses_abc", undefined] },
    ]);
    const out = JSON.parse(stdout);
    expect(out.participant_id).toBe("p_new");
    expect(out.kind).toBe("human");
    expect(typeof out.token).toBe("string");
  });

  it("fails when <session-id> is missing", async () => {
    await run(["new"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });
});

describe("runParticipant revoke", () => {
  it("revokes the given (session-id, participant-id) pair", async () => {
    await run(["revoke", "ses_abc", "p_xyz"]);
    expect(calls).toEqual([
      { method: "revokeParticipant", args: ["ses_abc", "p_xyz"] },
    ]);
    expect(JSON.parse(stdout)).toEqual({
      session_id: "ses_abc",
      participant_id: "p_xyz",
      revoked: true,
    });
  });

  it("fails when either id is missing", async () => {
    await run(["revoke"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);

    stderr = "";
    exitCode = undefined;
    await run(["revoke", "ses_abc"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe("runParticipant dispatch", () => {
  it("rejects an unknown subcommand", async () => {
    await run(["wat", "ses_abc"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("requires a subcommand", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing subcommand");
    expect(calls).toHaveLength(0);
  });
});
