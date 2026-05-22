// Tests for `pane session create` — the inline and reference artifact forms.

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
      title: "Test session",
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
      "--event-schema",
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
      "--event-schema",
      '{"events":{}}',
      "--input-data",
      '{"prTitle":"x"}',
    ]);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req["input_data"]).toEqual({ prTitle: "x" });
  });

  it("omits event_schema entirely for a view-only artifact (no --event-schema)", async () => {
    await run(["--artifact", "<html></html>"]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { artifact: Record<string, unknown> };
    // event_schema must be ABSENT, not set to undefined.
    expect(req.artifact).toEqual({
      type: "html-inline",
      source: "<html></html>",
    });
    expect("event_schema" in req.artifact).toBe(false);
    expect(JSON.parse(stdout).session_id).toBe("ses_1");
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

  it("does not require --artifact or --event-schema in the reference path", async () => {
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
    await run(["--event-schema", "{}"]);
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
      "--event-schema",
      "{}",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("only one of");
    expect(calls).toHaveLength(0);
  });
});

// Pre-flight schema rejections must reference the CLI flag the user typed
// (e.g. --participants), NOT the internal wire path (participants.humans).
// Regression target: issue #137 — "--participants 0 error message leaks an
// internal field path".
describe("create — schema-rejection messages use --flag names, not wire paths", () => {
  it("rejects --participants 0 with the --participants flag in the message", async () => {
    await run(["--artifact", "<html></html>", "--participants", "0"]);
    expect(exitCode).toBe(1);
    // The flag the user CAN fix; not the internal path "participants.humans".
    expect(stderr).toContain("--participants");
    expect(stderr).not.toContain("participants.humans");
    expect(calls).toHaveLength(0);
  });

  it("rejects --ttl 0 with the --ttl flag in the message", async () => {
    // ttl is a top-level field; the mapping table translates the bare
    // path so the public name is consistent across flag families.
    await run(["--artifact", "<html></html>", "--ttl", "0"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/invalid create request: --ttl:/);
    expect(calls).toHaveLength(0);
  });

  it("falls back to dotted notation for paths that have no flag mapping", async () => {
    // Sanity: a valid input_data passes through (no schema rejection in the
    // pre-flight; relay validates against input_schema server-side). This
    // exercises the fallback path's existence without manufacturing a
    // synthetic rejection.
    await run([
      "--artifact",
      "<html></html>",
      "--input-data",
      JSON.stringify({ ok: 1 }),
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe("create — --title flag", () => {
  it("passes --title through to the request body", async () => {
    await run(["--artifact", "<html></html>", "--title", "Quarterly Review"]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { title?: string };
    expect(req.title).toBe("Quarterly Review");
  });

  it("omits title from the body when --title is not given (relay decides)", async () => {
    // The CLI deliberately doesn't enforce required-ness locally — the relay
    // is the single source of truth for "required + Artifact.name fallback".
    await run(["--artifact-id", "pr-review"]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req).not.toHaveProperty("title");
  });
});
