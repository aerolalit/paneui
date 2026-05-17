// Unit tests for the hand-rolled argv parser.

import { describe, it, expect } from "vitest";
import { parseArgs, ArgvError } from "./argv.js";

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
});
