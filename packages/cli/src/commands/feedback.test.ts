// Tests for `pane feedback` — subcommand dispatch, create's flag/stdin
// requirements, and list's option pass-through.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";

const calls: { method: string; args: unknown[] }[] = [];
const submission = {
  id: "fb_abc123",
  type: "bug" as const,
  created_at: "2026-05-20T00:00:00.000Z",
};
const page = {
  items: [
    {
      id: "fb_abc123",
      type: "bug" as const,
      message: "x",
      pane_id: null,
      created_at: "2026-05-20T00:00:00.000Z",
    },
  ],
};
const fakeClient = {
  submitFeedback: vi.fn((req: unknown) => {
    calls.push({ method: "submitFeedback", args: [req] });
    return Promise.resolve(submission);
  }),
  listFeedback: vi.fn((opts: unknown) => {
    calls.push({ method: "listFeedback", args: [opts] });
    return Promise.resolve(page);
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runFeedback } from "./feedback.js";
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
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    get: () => true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runFeedback(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runFeedback dispatch", () => {
  it("rejects a missing subcommand", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("invalid_args");
    expect(stderr).toContain("missing subcommand");
  });

  it("rejects an unknown subcommand", async () => {
    await run(["frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown feedback subcommand");
  });
});

describe("feedback create", () => {
  it("requires --type", async () => {
    await run(["create", "--message", "hi"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--type");
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown --type", async () => {
    await run(["create", "--type", "praise", "--message", "hi"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown --type");
    expect(calls).toHaveLength(0);
  });

  it("requires --message", async () => {
    await run(["create", "--type", "bug"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--message");
    expect(calls).toHaveLength(0);
  });

  it("submits a literal --message", async () => {
    await run(["create", "--type", "bug", "--message", "boom"]);
    expect(calls).toEqual([
      {
        method: "submitFeedback",
        args: [{ type: "bug", message: "boom" }],
      },
    ]);
    expect(JSON.parse(stdout)).toEqual(submission);
  });

  it("passes --pane-id when provided", async () => {
    await run([
      "create",
      "--type",
      "feature",
      "--message",
      "x",
      "--pane-id",
      "sess_1",
    ]);
    expect(calls).toEqual([
      {
        method: "submitFeedback",
        args: [{ type: "feature", message: "x", paneId: "sess_1" }],
      },
    ]);
  });

  it("refuses --message - when stdin is a TTY", async () => {
    await run(["create", "--type", "note", "--message", "-"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("TTY");
    expect(calls).toHaveLength(0);
  });

  it("reads --message from stdin when '-' is given", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      get: () => false,
    });
    const piped = Readable.from([
      "multi-line\nfeedback\n",
    ]) as unknown as typeof process.stdin;
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", {
      configurable: true,
      get: () => piped,
    });
    try {
      await run(["create", "--type", "note", "--message", "-"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("submitFeedback");
      expect(calls[0]!.args[0]).toEqual({
        type: "note",
        message: "multi-line\nfeedback\n",
      });
    } finally {
      Object.defineProperty(process, "stdin", {
        configurable: true,
        get: () => originalStdin,
      });
    }
  });

  it("rejects an empty message", async () => {
    await run(["create", "--type", "note", "--message", "   \n\t  "]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("empty");
    expect(calls).toHaveLength(0);
  });
});

describe("feedback list", () => {
  it("lists with no options", async () => {
    await run(["list"]);
    expect(calls).toEqual([{ method: "listFeedback", args: [{}] }]);
    expect(JSON.parse(stdout)).toEqual(page);
  });

  it("passes --limit through", async () => {
    await run(["list", "--limit", "10"]);
    expect(calls).toEqual([{ method: "listFeedback", args: [{ limit: 10 }] }]);
  });

  it("rejects a non-positive --limit", async () => {
    await run(["list", "--limit", "0"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--limit");
    expect(calls).toHaveLength(0);
  });

  it("passes --before through", async () => {
    await run(["list", "--before", "2026-05-20T00:00:00.000Z"]);
    expect(calls).toEqual([
      {
        method: "listFeedback",
        args: [{ before: "2026-05-20T00:00:00.000Z" }],
      },
    ]);
  });
});
