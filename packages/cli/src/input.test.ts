// Unit tests for resolveJson / resolveText — file-path vs inline content, and
// the I3 fs-error case (only ENOENT means "not a file").

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveJson, resolveText } from "./input.js";

let dir: string;
let jsonFile: string;
let textFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-input-"));
  jsonFile = join(dir, "payload.json");
  textFile = join(dir, "template.html");
  writeFileSync(jsonFile, JSON.stringify({ from: "file" }));
  writeFileSync(textFile, "<h1>hi</h1>");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveJson", () => {
  it("reads and parses JSON from a file path", () => {
    expect(resolveJson(jsonFile, "--schema")).toEqual({ from: "file" });
  });

  it("parses an inline JSON literal", () => {
    expect(resolveJson('{"from":"inline"}', "--schema")).toEqual({
      from: "inline",
    });
  });

  it("throws a labeled error on invalid JSON", () => {
    expect(() => resolveJson("{not json", "--schema")).toThrow(
      /--schema: not valid JSON/,
    );
  });
});

describe("resolveText", () => {
  it("reads raw text from a file path", () => {
    expect(resolveText(textFile)).toBe("<h1>hi</h1>");
  });

  it("returns an inline literal verbatim (not a path)", () => {
    expect(resolveText("<p>inline</p>")).toBe("<p>inline</p>");
  });

  it("treats a missing path as inline content (ENOENT → not a file)", () => {
    // A non-existent path is JSON-ish text, used verbatim.
    expect(resolveText("/no/such/path/here.html")).toBe(
      "/no/such/path/here.html",
    );
  });
});

describe("isFilePath fs-error handling (I3)", () => {
  it("propagates a non-ENOENT fs error instead of misreporting as inline", () => {
    // An unreadable directory makes statSync on a child throw EACCES on most
    // POSIX systems. Skip the assertion when running as root (no EACCES).
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const locked = mkdtempSync(join(tmpdir(), "pane-locked-"));
    const child = join(locked, "inner.json");
    writeFileSync(child, "{}");
    try {
      chmodSync(locked, 0o000);
      // statSync(child) should now fail with EACCES, not ENOENT.
      expect(() => resolveJson(child, "--schema")).toThrow(/cannot stat/);
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
    }
  });
});
