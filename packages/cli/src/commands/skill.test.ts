// Tests for `pane skill` — fetch the relay's SKILL.md, print to stdout.
//
// Pinned contracts:
//   - resolves URL from --url / PANE_URL / store / hosted default (no API
//     key required)
//   - hits GET <relay>/skills/pane/SKILL.md exactly
//   - writes raw markdown to stdout, appending a trailing newline only when
//     the body lacks one
//   - sends x-pane-cli-version so log-based audits can see CLI versions
//   - on non-2xx, exits non-zero with a JSON error envelope on stderr;
//     stdout stays empty so a pipe-reader doesn't see partial markdown

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  // The mocked resolver returns the URL we control; the real one would walk
  // the precedence chain. Independent unit coverage for the chain lives in
  // config.ts's own tests.
  resolveRelayUrl: () => "https://relay.test",
}));

vi.mock("../version.js", () => ({
  VERSION: "9.9.9",
}));

import { runSkill } from "./skill.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "once", "help", "print-key", "yes", "plain"]);
function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let stdout: string;
let stderr: string;
let exitCode: number | undefined;
let lastFetchUrl: string | undefined;
let lastFetchInit: RequestInit | undefined;

beforeEach(() => {
  stdout = "";
  stderr = "";
  exitCode = undefined;
  lastFetchUrl = undefined;
  lastFetchInit = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += String(s);
    return true;
  });
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

function stubFetch(
  res:
    | { status: number; ok?: boolean; body?: string; json?: unknown }
    | "throw",
): void {
  // Replace global fetch (Node 20+ has it; tests run on Node 20+).
  // @ts-expect-error — overriding the global for test scope.
  globalThis.fetch = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    lastFetchUrl = url;
    lastFetchInit = init;
    if (res === "throw") throw new Error("connect ECONNREFUSED");
    return {
      status: res.status,
      ok: res.ok ?? (res.status >= 200 && res.status < 300),
      text: async () => res.body ?? "",
      // `pane skill version` reads JSON; provide it if the test supplied
      // one. A test that gives a body string but no `json` falls through
      // to a JSON.parse(body) so the realistic { "version": "..." } shape
      // works without duplicating it in both fields.
      json: async () => {
        if (res.json !== undefined) return res.json;
        return JSON.parse(res.body ?? "null");
      },
    } as unknown as Response;
  };
}

async function run(tokens: string[]): Promise<void> {
  try {
    await runSkill(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("runSkill", () => {
  it("GETs <relay>/skills/pane/SKILL.md and writes the body to stdout", async () => {
    stubFetch({ status: 200, body: "# pane\n\nbody\n" });
    await run(["show"]);
    expect(exitCode).toBeUndefined();
    expect(lastFetchUrl).toBe("https://relay.test/skills/pane/SKILL.md");
    expect(stdout).toBe("# pane\n\nbody\n");
  });

  it("sends x-pane-cli-version header (consistency with /v1/* — useful for audit logs)", async () => {
    // The skill route is mounted above the version-skew middleware so the
    // header is informational here, but we still send it so a relay's
    // access log can see which CLI versions are reading the skill.
    stubFetch({ status: 200, body: "ok\n" });
    await run(["show"]);
    const headers = lastFetchInit?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["x-pane-cli-version"]).toBe("9.9.9");
  });

  it("appends a trailing newline if the relay's body lacks one", async () => {
    // Cat-friendly: piping into another tool should always see a clean line
    // boundary. A trailing newline already present is preserved as-is.
    stubFetch({ status: 200, body: "no trailing newline" });
    await run(["show"]);
    expect(stdout).toBe("no trailing newline\n");
  });

  it("does NOT add a second newline when the body already ends in one", async () => {
    stubFetch({ status: 200, body: "ends with newline\n" });
    await run(["show"]);
    expect(stdout).toBe("ends with newline\n");
  });

  it("exits non-zero with relay_error on a 404 (e.g. operator stripped the route)", async () => {
    // The skill route is optional in principle — surface the relay's
    // status + body snippet rather than just "command failed".
    stubFetch({ status: 404, body: "not found" });
    await run(["show"]);
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr).error as { code: string; message: string };
    expect(err.code).toBe("relay_error");
    expect(err.message).toContain("404");
    expect(err.message).toContain("not found");
    // Stdout must stay clean — a pipe-reader that's redirecting stdout to
    // a file mustn't see a partial / garbage body on the error path.
    expect(stdout).toBe("");
  });

  it("exits non-zero with fetch_error when the relay is unreachable", async () => {
    stubFetch("throw");
    await run(["show"]);
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr).error as { code: string; message: string };
    expect(err.code).toBe("fetch_error");
    expect(err.message).toContain("https://relay.test/skills/pane/SKILL.md");
  });
});

// `pane skill version` — the version-only probe that drives the agent's
// "is my local skill stale?" check.
describe("runSkill — version subcommand", () => {
  it("GETs /skills/pane/SKILL.md/version and prints the JSON envelope by default", async () => {
    stubFetch({ status: 200, body: JSON.stringify({ version: "1.2.3" }) });
    await run(["version"]);
    expect(exitCode).toBeUndefined();
    expect(lastFetchUrl).toBe(
      "https://relay.test/skills/pane/SKILL.md/version",
    );
    // Default envelope — easy to consume from anything reading the CLI's
    // JSON-on-stdout contract.
    expect(stdout.trim()).toBe('{"version":"1.2.3"}');
  });

  it("with --plain prints just the version string + newline", async () => {
    // The shell-pipeline form. An agent's surface-start hook does:
    //   if [ "$(pane skill version --plain)" != "$LOCAL" ]; then ...
    // — so --plain MUST emit a bare line, no JSON braces, no trailing
    // whitespace beyond the newline.
    stubFetch({ status: 200, body: JSON.stringify({ version: "1.2.3" }) });
    await run(["version", "--plain"]);
    expect(stdout).toBe("1.2.3\n");
  });

  it("sends x-pane-cli-version on the version probe too (for audit logs)", async () => {
    stubFetch({ status: 200, body: JSON.stringify({ version: "1.0.0" }) });
    await run(["version"]);
    const headers = lastFetchInit?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["x-pane-cli-version"]).toBe("9.9.9");
  });

  it("falls through to 0.0.0 on a malformed version payload (defensive)", async () => {
    // A misbehaving relay returning { version: 42 } or {} must not crash
    // the probe. Same fallback the relay itself uses when its SKILL.md
    // lacks a version comment — the agent comparing its (presumably
    // newer) local version to 0.0.0 will skip the update rather than
    // loop on a broken contract.
    stubFetch({ status: 200, body: JSON.stringify({ version: 42 }) });
    await run(["version", "--plain"]);
    expect(stdout).toBe("0.0.0\n");
  });

  it("falls through to 0.0.0 when the body isn't valid JSON", async () => {
    stubFetch({ status: 200, body: "not json" });
    await run(["version", "--plain"]);
    expect(stdout).toBe("0.0.0\n");
  });

  it("exits non-zero with relay_error on a 404", async () => {
    // Same shape as `pane skill` itself — an operator that strips
    // /skills/pane/SKILL.md will usually strip /version too.
    stubFetch({ status: 404, body: "not found" });
    await run(["version"]);
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr).error as { code: string; message: string };
    expect(err.code).toBe("relay_error");
    expect(err.message).toContain("404");
  });

  it("exits non-zero with fetch_error when the relay is unreachable", async () => {
    stubFetch("throw");
    await run(["version"]);
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr).error as { code: string; message: string };
    expect(err.code).toBe("fetch_error");
  });

  it("rejects an unknown verb with invalid_args", async () => {
    // Future-proofs the verb dispatch: typos shouldn't silently fall through.
    await run(["nope"]);
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr).error as { code: string; message: string };
    expect(err.code).toBe("invalid_args");
    expect(err.message).toContain("unknown skill verb");
  });

  it("rejects a missing verb with invalid_args", async () => {
    // Bare `pane skill` is no longer an implicit fetch — the verb is now
    // explicit (`show` vs `version`) so a typo doesn't mask intent.
    await run([]);
    expect(exitCode).toBe(1);
    const err = JSON.parse(stderr).error as { code: string; message: string };
    expect(err.code).toBe("invalid_args");
    expect(err.message).toContain("missing verb");
  });
});
