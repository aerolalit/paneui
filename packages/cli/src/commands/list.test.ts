// Tests for `pane list` — argument validation and request shaping.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  listSessions: vi.fn((opts: unknown) => {
    calls.push({ method: "listSessions", args: [opts] });
    return Promise.resolve({ items: [], next_cursor: null });
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runList } from "./list.js";
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
    await runList(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runList", () => {
  it("calls listSessions with no opts by default", async () => {
    await run([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toEqual({});
    expect(JSON.parse(stdout)).toEqual({ items: [], next_cursor: null });
  });

  it("forwards --status, --limit, --cursor, --artifact-id", async () => {
    await run([
      "--status",
      "all",
      "--limit",
      "25",
      "--cursor",
      "opaque-cursor",
      "--artifact-id",
      "art_xyz",
    ]);
    expect(calls[0]!.args[0]).toEqual({
      status: "all",
      limit: 25,
      cursor: "opaque-cursor",
      artifact_id: "art_xyz",
    });
  });

  it("rejects an unknown --status before hitting the network", async () => {
    await run(["--status", "purple"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("rejects --limit out of 1..200", async () => {
    await run(["--limit", "0"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);

    stderr = "";
    exitCode = undefined;
    await run(["--limit", "201"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);

    stderr = "";
    exitCode = undefined;
    await run(["--limit", "notanumber"]);
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
