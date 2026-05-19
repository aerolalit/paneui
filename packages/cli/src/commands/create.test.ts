// Tests for `pane create` — the inline and reference artifact forms.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  createSession: vi.fn((req: unknown) => {
    calls.push({ method: "createSession", args: [req] });
    return Promise.resolve({
      session_id: "ses_1",
      tokens: { humans: [], agent: "t" },
      urls: { humans: [], agent_stream: "ws" },
      expires_at: "2026-01-01T00:00:00Z",
    });
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runCreate } from "./create.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key"]);

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
    await runCreate(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("create — inline artifact form", () => {
  it("builds the inline-form request with the event schema inside artifact", async () => {
    await run([
      "--artifact",
      "<html></html>",
      "--schema",
      '{"events":{}}',
      "--ttl",
      "600",
    ]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { artifact: Record<string, unknown> };
    expect(req.artifact).toEqual({
      type: "html-inline",
      source: "<html></html>",
      event_schema: { events: {} },
    });
    expect(JSON.parse(stdout).session_id).toBe("ses_1");
  });

  it("accepts --input-data on the inline path", async () => {
    await run([
      "--artifact",
      "<html></html>",
      "--schema",
      '{"events":{}}',
      "--input-data",
      '{"prTitle":"x"}',
    ]);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req["input_data"]).toEqual({ prTitle: "x" });
  });

  it("fails when --schema is missing in the inline path", async () => {
    await run(["--artifact", "<html></html>"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing --schema");
    expect(calls).toHaveLength(0);
  });
});

describe("create — reference artifact form", () => {
  it("builds a reference-form request from --artifact-id", async () => {
    await run(["--artifact-id", "pr-review"]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { artifact: Record<string, unknown> };
    expect(req.artifact).toEqual({ id: "pr-review" });
  });

  it("pins a version with --version", async () => {
    await run(["--artifact-id", "art_1", "--version", "3"]);
    const req = calls[0]!.args[0] as { artifact: Record<string, unknown> };
    expect(req.artifact).toEqual({ id: "art_1", version: 3 });
  });

  it("carries --input-data on the reference path", async () => {
    await run([
      "--artifact-id",
      "pr-review",
      "--input-data",
      '{"diffUrl":"u"}',
    ]);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req["input_data"]).toEqual({ diffUrl: "u" });
  });

  it("does not require --artifact or --schema in the reference path", async () => {
    await run(["--artifact-id", "pr-review"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-positive --version", async () => {
    await run(["--artifact-id", "art_1", "--version", "0"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--version must be a positive integer");
  });
});

describe("create — exactly-one-of enforcement", () => {
  it("fails when neither --artifact nor --artifact-id is given", async () => {
    await run(["--schema", "{}"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing artifact");
    expect(calls).toHaveLength(0);
  });

  it("fails when both --artifact and --artifact-id are given", async () => {
    await run([
      "--artifact-id",
      "pr-review",
      "--artifact",
      "<html></html>",
      "--schema",
      "{}",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("only one of");
    expect(calls).toHaveLength(0);
  });
});
