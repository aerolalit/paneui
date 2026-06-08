// Tests for `pane create` — the inline and reference template forms.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  createPane: vi.fn((req: unknown) => {
    calls.push({ method: "createPane", args: [req] });
    return Promise.resolve({
      pane_id: "pan_1",
      tokens: { humans: [], agent: "t" },
      urls: { humans: [], agent_stream: "ws" },
      expires_at: "2026-01-01T00:00:00Z",
      title: "Test pane",
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

describe("create — inline template form", () => {
  it("builds the inline-form request with the event schema inside template", async () => {
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--event-schema",
      '{"events":{}}',
      "--ttl",
      "600",
    ]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { template: Record<string, unknown> };
    expect(req.template).toEqual({
      name: "Inline",
      type: "html-inline",
      source: "<html></html>",
      event_schema: { events: {} },
    });
    expect(JSON.parse(stdout).pane_id).toBe("pan_1");
  });

  it("requires --name on the inline form", async () => {
    await run([
      "--template",
      "<html></html>",
      "--event-schema",
      '{"events":{}}',
    ]);
    expect(calls).toHaveLength(0);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/--name is required with --template/);
  });

  it("carries --name and --slug into the inline template body", async () => {
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Approval form",
      "--slug",
      "approval-form",
    ]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { template: Record<string, unknown> };
    expect(req.template["name"]).toBe("Approval form");
    expect(req.template["slug"]).toBe("approval-form");
  });

  it("omits slug from the inline body when --slug is not given", async () => {
    await run(["--template", "<html></html>", "--name", "No slug"]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { template: Record<string, unknown> };
    expect("slug" in req.template).toBe(false);
  });

  it("parses --tags (comma-separated, trimmed, empties dropped) into req.tags", async () => {
    await run([
      "--template-id",
      "pr-review",
      "--tags",
      " cp-backend , pr-review ,, ",
    ]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { tags?: string[] };
    expect(req.tags).toEqual(["cp-backend", "pr-review"]);
  });

  it("omits tags when --tags is not given", async () => {
    await run(["--template-id", "pr-review"]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect("tags" in req).toBe(false);
  });

  it("accepts --input-data on the inline path", async () => {
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--event-schema",
      '{"events":{}}',
      "--input-data",
      '{"prTitle":"x"}',
    ]);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req["input_data"]).toEqual({ prTitle: "x" });
  });

  it("omits event_schema entirely for a view-only template (no --event-schema)", async () => {
    await run(["--template", "<html></html>", "--name", "Inline"]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { template: Record<string, unknown> };
    // event_schema must be ABSENT, not set to undefined.
    expect(req.template).toEqual({
      name: "Inline",
      type: "html-inline",
      source: "<html></html>",
    });
    expect("event_schema" in req.template).toBe(false);
    expect(JSON.parse(stdout).pane_id).toBe("pan_1");
  });

  it("plumbs --input-schema into template.input_schema (inline JSON) — #208", async () => {
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--input-schema",
      '{"type":"object","properties":{"x":{"type":"string"}}}',
    ]);
    const req = calls[0]!.args[0] as { template: Record<string, unknown> };
    expect(req.template["input_schema"]).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
    });
  });

  it("rejects a non-object --input-schema (array/primitive)", async () => {
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--input-schema",
      "[]",
    ]);
    expect(calls).toHaveLength(0);
    expect(stderr).toMatch(/--input-schema must be a JSON object/);
  });

  it("omits input_schema entirely when --input-schema isn't passed (no input contract)", async () => {
    await run(["--template", "<html></html>", "--name", "Inline"]);
    const req = calls[0]!.args[0] as { template: Record<string, unknown> };
    expect("input_schema" in req.template).toBe(false);
  });

  // --record-schema declares the inline template's per-pane record
  // collections (#476). Optional; absent = event-only one-off. Goes inside
  // `template`, alongside event_schema / input_schema.
  it("plumbs --record-schema into template.record_schema (inline JSON)", async () => {
    const recordSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Todo: {
          type: "object",
          properties: { text: { type: "string" }, done: { type: "boolean" } },
          required: ["text"],
        },
      },
      "x-pane-collections": {
        todos: {
          schema: { $ref: "#/$defs/Todo" },
          write: ["page", "agent"],
          delete: ["author"],
        },
      },
    };
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Todo list",
      "--record-schema",
      JSON.stringify(recordSchema),
    ]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { template: Record<string, unknown> };
    expect(req.template["record_schema"]).toEqual(recordSchema);
  });

  it("rejects a non-object --record-schema (array/primitive)", async () => {
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--record-schema",
      "[]",
    ]);
    expect(calls).toHaveLength(0);
    expect(stderr).toMatch(/--record-schema must be a JSON object/);
  });

  it("omits record_schema entirely when --record-schema isn't passed (event-only one-off)", async () => {
    await run(["--template", "<html></html>", "--name", "Inline"]);
    const req = calls[0]!.args[0] as { template: Record<string, unknown> };
    expect("record_schema" in req.template).toBe(false);
  });
});

describe("create — reference template form", () => {
  it("builds a reference-form request from --template-id", async () => {
    await run(["--template-id", "pr-review"]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { template: Record<string, unknown> };
    expect(req.template).toEqual({ id: "pr-review" });
  });

  it("pins a version with --version", async () => {
    await run(["--template-id", "art_1", "--version", "3"]);
    const req = calls[0]!.args[0] as { template: Record<string, unknown> };
    expect(req.template).toEqual({ id: "art_1", version: 3 });
  });

  it("carries --input-data on the reference path", async () => {
    await run([
      "--template-id",
      "pr-review",
      "--input-data",
      '{"diffUrl":"u"}',
    ]);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req["input_data"]).toEqual({ diffUrl: "u" });
  });

  it("does not require --template or --event-schema in the reference path", async () => {
    await run(["--template-id", "pr-review"]);
    expect(exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-positive --version", async () => {
    await run(["--template-id", "art_1", "--version", "0"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--version must be a positive integer");
  });

  it("rejects --input-schema combined with --template-id (#208)", async () => {
    // Named templates pin a version that already carries an input_schema;
    // accepting --input-schema here would silently shadow it. Fail fast.
    await run([
      "--template-id",
      "pr-review",
      "--input-schema",
      '{"type":"object"}',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "--input-schema is incompatible with --template-id",
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects --record-schema combined with --template-id (#476)", async () => {
    // Same reasoning as --input-schema above: the pinned template version
    // already carries any record_schema. Silent shadowing would be worse
    // than a fast fail.
    await run([
      "--template-id",
      "pr-review",
      "--record-schema",
      '{"x-pane-collections":{"todos":{}}}',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "--record-schema is incompatible with --template-id",
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects --name combined with --template-id (reference form has no name to set)", async () => {
    await run(["--template-id", "pr-review", "--name", "Nope"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--name is incompatible with --template-id");
    expect(calls).toHaveLength(0);
  });

  it("rejects --slug combined with --template-id", async () => {
    await run(["--template-id", "pr-review", "--slug", "nope"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--slug is incompatible with --template-id");
    expect(calls).toHaveLength(0);
  });
});

describe("create — exactly-one-of enforcement", () => {
  it("fails when neither --template nor --template-id is given", async () => {
    await run(["--event-schema", "{}"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing template");
    expect(calls).toHaveLength(0);
  });

  it("fails when both --template and --template-id are given", async () => {
    await run([
      "--template-id",
      "pr-review",
      "--template",
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
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--participants",
      "0",
    ]);
    expect(exitCode).toBe(1);
    // The flag the user CAN fix; not the internal path "participants.humans".
    expect(stderr).toContain("--participants");
    expect(stderr).not.toContain("participants.humans");
    expect(calls).toHaveLength(0);
  });

  it("rejects --ttl 0 with the --ttl flag in the message", async () => {
    // ttl is a top-level field; the mapping table translates the bare
    // path so the public name is consistent across flag families.
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--ttl",
      "0",
    ]);
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
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--input-data",
      JSON.stringify({ ok: 1 }),
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe("create — --title flag", () => {
  it("passes --title through to the request body", async () => {
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--title",
      "Quarterly Review",
    ]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { title?: string };
    expect(req.title).toBe("Quarterly Review");
  });

  it("omits title from the body when --title is not given (relay decides)", async () => {
    // The CLI deliberately doesn't enforce required-ness locally — the relay
    // is the single source of truth for "required + Template.name fallback".
    await run(["--template-id", "pr-review"]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req).not.toHaveProperty("title");
  });
});

describe("create — --preamble flag", () => {
  it("passes --preamble through to the request body", async () => {
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--title",
      "Approve",
      "--preamble",
      "Your CI bot wants you to approve a deploy.",
    ]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { preamble?: string };
    expect(req.preamble).toBe("Your CI bot wants you to approve a deploy.");
  });

  it("omits preamble from the body when --preamble is not given", async () => {
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--title",
      "no preamble",
    ]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req).not.toHaveProperty("preamble");
  });
});

describe("create — --context-key flag (#262)", () => {
  it("passes --context-key through to the request body as context_key", async () => {
    // Phase G dedup is keyed off context_key. The CLI flag is the only path
    // for an agent to drive that dedup without dropping to raw curl.
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--title",
      "PR review",
      "--context-key",
      "pr-42",
    ]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as { context_key?: string };
    expect(req.context_key).toBe("pr-42");
  });

  it("omits context_key from the body when --context-key is not given", async () => {
    // Without the flag, no dedup — the relay treats absent context_key as
    // the legacy "every create is a fresh pane" behaviour.
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--title",
      "ad-hoc",
    ]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!.args[0] as Record<string, unknown>;
    expect(req).not.toHaveProperty("context_key");
  });

  it("panes schema rejection of an invalid context_key under the right flag", async () => {
    // The shared @paneui/core schema enforces charset + length on
    // context_key; a bad value rejects BEFORE we hit the wire, and the
    // CLI's schema-path-to-flag mapping translates the rejection's
    // internal path back to --context-key (not the wire path).
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--title",
      "bad key",
      "--context-key",
      "has spaces — not allowed",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--context-key");
    expect(stderr).not.toContain("context_key:");
    expect(calls).toHaveLength(0);
  });
});

// The fake client at the top of this file returns urls.humans=[]; for the
// TTY-output tests we replace its implementation so the formatter has a
// real URL + an expires_at to render against.
const ttySample = {
  pane_id: "pan_tty",
  tokens: { humans: ["tok_h_one"], agent: "tok_a_x" },
  urls: {
    humans: ["https://relay.test/s/tok_h_one"],
    agent_stream: "wss://relay.test/v1/panes/pan_tty/stream",
  },
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  title: "PR review",
};

describe("create — output mode (TTY vs --json)", () => {
  let originalIsTty: unknown;
  beforeEach(() => {
    originalIsTty = (process.stdout as unknown as { isTTY?: boolean }).isTTY;
    fakeClient.createPane.mockImplementation((req: unknown) => {
      calls.push({ method: "createPane", args: [req] });
      return Promise.resolve(ttySample);
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalIsTty,
    });
  });

  function setTty(v: boolean): void {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: v,
    });
  }

  it("emits human-readable output on a TTY by default", async () => {
    setTty(true);
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--title",
      "PR review",
    ]);
    expect(stdout).toContain("PR review");
    expect(stdout).toContain("https://relay.test/s/tok_h_one");
    // The human form doesn't start with `{` — that's the JSON tell.
    expect(stdout.trimStart().startsWith("{")).toBe(false);
  });

  it("emits JSON when --json is passed even on a TTY", async () => {
    setTty(true);
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--title",
      "PR review",
      "--json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.pane_id).toBe("pan_tty");
  });

  it("emits JSON when stdout is not a TTY (piped)", async () => {
    setTty(false);
    await run([
      "--template",
      "<html></html>",
      "--name",
      "Inline",
      "--title",
      "PR review",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.pane_id).toBe("pan_tty");
  });
});

describe("create — unknown-flag rejection (#224)", () => {
  it("rejects an unknown value-flag and never reaches the relay", async () => {
    // Pre-#224 the CLI silently dropped the flag and created the pane.
    // Now it must throw an ArgvError before makeClient is touched — the
    // top-level main().catch translates that to an invalid_args envelope.
    await expect(
      runCreate(
        argv([
          "--totally-fake-flag",
          "oops",
          "--template",
          "<html></html>",
          "--title",
          "smoke",
          "--ttl",
          "60",
        ]),
      ),
    ).rejects.toThrow("unknown flag(s): --totally-fake-flag");
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown boolean flag", async () => {
    await expect(
      runCreate(
        argv([
          "--template",
          "<html></html>",
          "--title",
          "smoke",
          "--once", // --once is parsed as a bool (it's in BOOLS) but `create` does not accept it
        ]),
      ),
    ).rejects.toThrow("unknown flag(s): --once");
    expect(calls).toHaveLength(0);
  });
});
