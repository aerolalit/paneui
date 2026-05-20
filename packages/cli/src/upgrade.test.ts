// Unit tests for the upgrade helpers. These pin the contract the skill
// instructs the agent to rely on:
//   - exit code stays 75 (sysexits EX_TEMPFAIL)
//   - install-method detection covers npm-global, bun-global, volta,
//     vendored, and unknown
//   - the printed upgrade command is shaped so an agent (or human) can run
//     it without further interpretation
//   - a `vendored` install never prints a runnable command — the project's
//     package.json owns the version, not the CLI itself

import { describe, it, expect } from "vitest";
import { PaneApiError } from "@paneui/core";
import {
  detectInstallMethod,
  upgradeCommandFor,
  formatUpgradeMessage,
  EXIT_CLI_UPGRADE_REQUIRED,
} from "./upgrade.js";

describe("detectInstallMethod", () => {
  it("recognises a system-wide npm global install", () => {
    expect(
      detectInstallMethod(
        "/usr/local/lib/node_modules/@paneui/cli/dist/index.js",
      ),
    ).toBe("npm-global");
    expect(
      detectInstallMethod("/usr/lib/node_modules/@paneui/cli/dist/index.js"),
    ).toBe("npm-global");
  });

  it("recognises a per-user npm-prefix install", () => {
    expect(
      detectInstallMethod(
        "/home/me/.npm-global/lib/node_modules/@paneui/cli/dist/index.js",
      ),
    ).toBe("npm-global");
  });

  it("recognises an nvm install (still npm)", () => {
    // nvm puts global packages under each Node version's directory.
    expect(
      detectInstallMethod(
        "/Users/me/.nvm/versions/node/v20.11.1/lib/node_modules/@paneui/cli/dist/index.js",
      ),
    ).toBe("npm-global");
  });

  it("recognises a bun global install", () => {
    expect(
      detectInstallMethod(
        "/Users/me/.bun/install/global/node_modules/@paneui/cli/dist/index.js",
      ),
    ).toBe("bun-global");
  });

  it("recognises a volta install (binaries live under .volta/)", () => {
    expect(
      detectInstallMethod(
        "/Users/me/.volta/tools/image/packages/@paneui/cli/lib/node_modules/@paneui/cli/dist/index.js",
      ),
    ).toBe("volta");
  });

  it("recognises a vendored install (in a project's node_modules)", () => {
    // The project-local case — `npm i @paneui/cli` (no -g), or a yarn/pnpm
    // dep. The path is inside the project, not a global prefix.
    expect(
      detectInstallMethod(
        "/Users/me/work/myproj/node_modules/@paneui/cli/dist/index.js",
      ),
    ).toBe("vendored");
  });

  it("falls back to 'unknown' for everything else (npx cache, pnpm temp, …)", () => {
    expect(
      detectInstallMethod(
        "/Users/me/Library/Caches/_npx/abc123/node_modules/@paneui/cli/dist/index.js",
      ),
    ).toBe("unknown");
    expect(detectInstallMethod("/tmp/some/random/path/index.js")).toBe(
      "unknown",
    );
  });
});

describe("upgradeCommandFor", () => {
  it("uses npm for npm-global, bun for bun-global, volta for volta", () => {
    expect(upgradeCommandFor("npm-global", "0.0.7")).toBe(
      "npm install -g @paneui/cli@>=0.0.7",
    );
    expect(upgradeCommandFor("bun-global", "0.0.7")).toBe(
      "bun install -g @paneui/cli@>=0.0.7",
    );
    expect(upgradeCommandFor("volta", "0.0.7")).toBe(
      "volta install @paneui/cli@>=0.0.7",
    );
  });

  it("returns null for vendored — the project's package.json owns the version", () => {
    // We MUST NOT print a global-install command for a vendored install;
    // that would upgrade a global pane next to the vendored one and leave
    // the agent confused about which is being executed.
    expect(upgradeCommandFor("vendored", "0.0.7")).toBeNull();
  });

  it("returns null for unknown — escalate to the human", () => {
    expect(upgradeCommandFor("unknown", "0.0.7")).toBeNull();
  });

  it("pins the upgrade target to >=min, not @latest", () => {
    // Self-hosted relay at 0.0.7 must not pull a future 0.1.0 that may
    // have its own incompatibilities. The relay says 'min', we install
    // 'min or above', npm picks the satisfying latest.
    expect(upgradeCommandFor("npm-global", "0.0.7")).toContain(">=0.0.7");
  });
});

describe("formatUpgradeMessage", () => {
  function err(min: unknown, yours: unknown): PaneApiError {
    return new PaneApiError(
      426,
      "cli_upgrade_required",
      `this relay requires @paneui/cli >= ${min} (you sent ${yours})`,
      { min_version: min, your_version: yours },
    );
  }

  it("prints the version line and the runnable command for npm-global", () => {
    const msg = formatUpgradeMessage(
      err("0.0.7", "0.0.5"),
      "npm-global",
      "npm install -g @paneui/cli@>=0.0.7",
    );
    expect(msg).toContain(">= 0.0.7");
    expect(msg).toContain("0.0.5");
    expect(msg).toContain("npm install -g @paneui/cli@>=0.0.7");
  });

  it("tells the human to bump the dep on a vendored install", () => {
    const msg = formatUpgradeMessage(err("0.0.7", "0.0.5"), "vendored", null);
    expect(msg).toContain("vendored");
    // No bogus shell command — vendored installs are owned by the project's
    // package.json, not by global npm.
    expect(msg).not.toContain("npm install -g");
  });

  it("tells the human to handle it on an unknown install", () => {
    const msg = formatUpgradeMessage(err("0.0.7", "0.0.5"), "unknown", null);
    expect(msg).toContain("unknown");
    expect(msg).not.toContain("npm install -g");
  });

  it("tolerates a malformed details object — never crashes", () => {
    // The agent will be reading this string when something is already wrong
    // with the relay; the formatter must NOT throw on a misbehaving relay
    // payload. Missing / non-string details become '?' rather than an
    // exception.
    const malformed = new PaneApiError(426, "cli_upgrade_required", "x", null);
    const msg = formatUpgradeMessage(
      malformed,
      "npm-global",
      "npm install -g @paneui/cli@>=?",
    );
    expect(msg).toContain(">= ?");
  });
});

describe("EXIT_CLI_UPGRADE_REQUIRED", () => {
  it("is 75 — sysexits.h EX_TEMPFAIL, documented in SKILL.md", () => {
    // The skill instructs the agent's harness to branch on this exit code.
    // Changing this value is a CONTRACT BREAK — coordinate with SKILL.md
    // and bump the relay's MIN_CLI_VERSION so old agents don't loop.
    expect(EXIT_CLI_UPGRADE_REQUIRED).toBe(75);
  });
});
