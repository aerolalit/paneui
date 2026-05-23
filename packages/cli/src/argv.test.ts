// Unit tests for the hand-rolled argv parser.

import { describe, it, expect } from "vitest";
import { parseArgs, ArgvError, assertKnownFlags } from "./argv.js";

const BOOLS = new Set(["json", "once", "help", "version"]);

describe("parseArgs", () => {
  it("collects positionals", () => {
    const r = parseArgs(["ses_1", "ses_2"], BOOLS);
    expect(r.positionals).toEqual(["ses_1", "ses_2"]);
  });

  it("parses --flag value", () => {
    const r = parseArgs(["--url", "https://x.test"], BOOLS);
    expect(r.flags.get("url")).toBe("https://x.test");
  });

  it("parses --flag=value", () => {
    const r = parseArgs(["--url=https://x.test"], BOOLS);
    expect(r.flags.get("url")).toBe("https://x.test");
  });

  it("parses boolean flags", () => {
    const r = parseArgs(["--once"], BOOLS);
    expect(r.bools.has("once")).toBe(true);
  });

  it("maps -h and --help to the help bool", () => {
    expect(parseArgs(["-h"], BOOLS).bools.has("help")).toBe(true);
    expect(parseArgs(["--help"], BOOLS).bools.has("help")).toBe(true);
  });

  it("throws ArgvError when a value-flag has no argument (end of argv)", () => {
    expect(() => parseArgs(["--url"], BOOLS)).toThrow(ArgvError);
    expect(() => parseArgs(["--url"], BOOLS)).toThrow("--url requires a value");
  });

  it("throws ArgvError when a value-flag is followed by another flag", () => {
    expect(() => parseArgs(["--url", "--api-key", "k"], BOOLS)).toThrow(
      "--url requires a value",
    );
  });

  it("does not throw for a boolean flag at end of argv", () => {
    expect(() => parseArgs(["--once"], BOOLS)).not.toThrow();
  });

  it("handles a mix of positionals, flags, and bools", () => {
    const r = parseArgs(
      ["watch", "ses_1", "--type", "form.submitted", "--once"],
      BOOLS,
    );
    expect(r.positionals).toEqual(["watch", "ses_1"]);
    expect(r.flags.get("type")).toBe("form.submitted");
    expect(r.bools.has("once")).toBe(true);
  });

  it("throws on a repeated value-flag (space form)", () => {
    expect(() => parseArgs(["--url", "a", "--url", "b"], BOOLS)).toThrow(
      ArgvError,
    );
    expect(() => parseArgs(["--url", "a", "--url", "b"], BOOLS)).toThrow(
      "duplicate flag: --url",
    );
  });

  it("throws on a repeated value-flag (equals form)", () => {
    expect(() => parseArgs(["--url=a", "--url=b"], BOOLS)).toThrow(
      "duplicate flag: --url",
    );
  });

  it("throws on a repeated value-flag mixing space + equals", () => {
    expect(() => parseArgs(["--url", "a", "--url=b"], BOOLS)).toThrow(
      "duplicate flag: --url",
    );
  });

  it("throws on a repeated boolean flag", () => {
    expect(() => parseArgs(["--once", "--once"], BOOLS)).toThrow(
      "duplicate flag: --once",
    );
  });
});

describe("assertKnownFlags", () => {
  const empty = {
    positionals: [],
    flags: new Map<string, string>(),
    bools: new Set<string>(),
  };

  it("accepts nothing-passed", () => {
    expect(() => assertKnownFlags(empty, [], [], "pane example")).not.toThrow();
  });

  it("accepts the per-command allow-list", () => {
    const args = {
      positionals: [],
      flags: new Map([
        ["file", "/tmp/x"],
        ["scope", "agent"],
      ]),
      bools: new Set(["once"]),
    };
    expect(() =>
      assertKnownFlags(args, ["file", "scope"], ["once"], "pane example"),
    ).not.toThrow();
  });

  it("always accepts global flags (--url / --api-key / --json / --help)", () => {
    const args = {
      positionals: [],
      flags: new Map([
        ["url", "https://x.test"],
        ["api-key", "pk_secret"],
      ]),
      bools: new Set(["json", "help"]),
    };
    // No per-command knowledge — globals still pass.
    expect(() => assertKnownFlags(args, [], [], "pane example")).not.toThrow();
  });

  it("rejects an unknown value-flag with a hinted ArgvError", () => {
    const args = {
      positionals: [],
      flags: new Map([["totally-fake-flag", "oops"]]),
      bools: new Set<string>(),
    };
    let caught: ArgvError | undefined;
    try {
      assertKnownFlags(args, ["file"], [], "pane blob upload");
    } catch (e) {
      caught = e as ArgvError;
    }
    expect(caught).toBeInstanceOf(ArgvError);
    expect(caught!.message).toBe("unknown flag(s): --totally-fake-flag");
    expect(caught!.hint).toBe(
      "run `pane blob upload --help` for the supported flags",
    );
  });

  it("rejects an unknown boolean flag", () => {
    const args = {
      positionals: [],
      flags: new Map<string, string>(),
      bools: new Set(["bogus"]),
    };
    expect(() => assertKnownFlags(args, [], [], "pane example")).toThrow(
      "unknown flag(s): --bogus",
    );
  });

  it("reports every unknown flag in one message", () => {
    const args = {
      positionals: [],
      flags: new Map([
        ["foo", "1"],
        ["bar", "2"],
      ]),
      bools: new Set(["baz"]),
    };
    let msg = "";
    try {
      assertKnownFlags(args, [], [], "pane example");
    } catch (e) {
      msg = (e as ArgvError).message;
    }
    // All three reported — saves the user re-running once per typo.
    expect(msg).toContain("--foo");
    expect(msg).toContain("--bar");
    expect(msg).toContain("--baz");
  });
});
