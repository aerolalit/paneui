// Tests for `pane delete` — pane deletion and missing-id handling.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  deletePane: vi.fn((id: unknown) => {
    calls.push({ method: "deletePane", args: [id] });
    return Promise.resolve();
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runDelete } from "./delete.js";
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
    await runDelete(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runDelete", () => {
  it("deletes the given pane id", async () => {
    await run(["pan_abc"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("deletePane");
    expect(calls[0]!.args[0]).toBe("pan_abc");
    expect(JSON.parse(stdout)).toEqual({
      pane_id: "pan_abc",
      deleted: true,
    });
  });

  it("fails when the pane id is missing", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(stderr).toContain("missing <pane-id>");
    expect(calls).toHaveLength(0);
  });
});
