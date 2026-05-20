// Integration tests for the upgrade-required exit path through failFromError
// and failUpgradeRequired. The skill (skills/pane/SKILL.md) instructs the
// agent's harness to detect a CLI-upgrade situation by:
//   - stderr containing "this relay requires @paneui/cli >="
//   - process exiting with code 75 (sysexits EX_TEMPFAIL)
//
// Both shapes must hold; this file pins them so a future refactor can't
// silently break the contract.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PaneApiError } from "@paneui/core";
import { failFromError, failUpgradeRequired } from "./output.js";

let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  stderr = "";
  exitCode = undefined;
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += String(s);
    return true;
  });
  // process.exit is mocked to throw a marker so we can resume control after
  // the never-returning failX call — matches the existing CLI test style.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function expectMarker(fn: () => void, code: number): void {
  try {
    fn();
    throw new Error("expected process.exit but function returned normally");
  } catch (e) {
    if (!(e instanceof Error && e.message === `__exit_${code}__`)) throw e;
  }
}

describe("failFromError on a 426 cli_upgrade_required", () => {
  it("prints the upgrade message and exits 75 (not the generic JSON envelope)", () => {
    const err = new PaneApiError(
      426,
      "cli_upgrade_required",
      "this relay requires @paneui/cli >= 0.0.7 (you sent 0.0.5)",
      { min_version: "0.0.7", your_version: "0.0.5" },
    );

    expectMarker(() => failFromError(err), 75);
    expect(exitCode).toBe(75);
    // The skill's "if you see this error" instructions match on this prefix
    // and version strings — keep both present.
    expect(stderr).toContain("this relay requires @paneui/cli >= 0.0.7");
    expect(stderr).toContain("0.0.5");
    // The CLI must NOT also print the generic { error: {...} } JSON envelope
    // here — the upgrade message stands alone so the agent's stderr parser
    // doesn't see two competing structures.
    expect(stderr).not.toContain('"code":"cli_upgrade_required"');
  });

  it("falls through to the generic envelope for other PaneApiError codes", () => {
    // A close cousin (also 4xx, also a PaneApiError) must NOT trip the
    // upgrade path — that path is specifically for the version-skew code.
    const err = new PaneApiError(429, "rate_limited", "slow down", undefined, {
      retryable: true,
    });
    expectMarker(() => failFromError(err), 1);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('"code":"rate_limited"');
  });
});

describe("failUpgradeRequired (direct entry)", () => {
  it("prints the version line and exits 75", () => {
    const err = new PaneApiError(426, "cli_upgrade_required", "x", {
      min_version: "0.0.7",
      your_version: "0.0.5",
    });
    expectMarker(() => failUpgradeRequired(err), 75);
    expect(exitCode).toBe(75);
    expect(stderr).toContain(">= 0.0.7");
    expect(stderr).toContain("0.0.5");
  });

  it("does not crash on a malformed details payload", () => {
    // A misbehaving relay could 426 with no details at all. The upgrade
    // path must still exit cleanly — the agent has nothing to act on, but
    // a crash mid-error-handling would be far worse than a vague message.
    const err = new PaneApiError(426, "cli_upgrade_required", "x", null);
    expectMarker(() => failUpgradeRequired(err), 75);
    expect(exitCode).toBe(75);
    expect(stderr).toContain("?");
  });
});
