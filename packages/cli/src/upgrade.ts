// CLI auto-upgrade helpers — install-method detection and message formatting.
//
// Called by the top-level error handler when a relay returns 426
// `cli_upgrade_required`. The goal is to print a single, machine-parseable
// line the agent can lift verbatim — and tell the human (or the agent's
// harness) exactly what to run instead of a generic "upgrade @paneui/cli".
//
// Detection is best-effort: we inspect `process.execPath` and the CLI's own
// install path. There's no programmatic "ask npm what installed me" API, so
// the heuristics below are matched against the well-known install layouts
// of each package manager. Anything unrecognized lands in `unknown`, which
// means "tell the agent to ask the human" rather than guess.

import { PaneApiError } from "@paneui/core";

/**
 * How the `pane` binary appears to have been installed. The detection looks
 * at well-known directory shapes (npm-global is /usr/lib/node_modules/, bun
 * is ~/.bun/install/global/, etc.). When nothing matches we return
 * `"unknown"` and the upgrade message tells the human to handle it.
 */
export type InstallMethod =
  | "npm-global"
  | "bun-global"
  | "volta"
  | "vendored"
  | "unknown";

/**
 * Detection rules, ordered most-specific to least. Each rule looks at the
 * directory the CLI is running from — caller passes `import.meta.url`-
 * derived absolute path for the CLI entry. The actual file at that path
 * doesn't need to exist; we're only pattern-matching the path itself, so
 * tests can pass synthetic strings.
 *
 * Patterns are deliberately loose (substring tests, not exact prefixes) so
 * the same rule handles per-user installs (`~/.npm-global/lib/node_modules/`),
 * system installs (`/usr/lib/node_modules/`), and the macOS/Linux
 * variations within each manager — without listing every layout.
 */
export function detectInstallMethod(entryPath: string): InstallMethod {
  // Volta wraps every binary in a shim under ~/.volta/tools/image/packages/
  // and re-exports it via ~/.volta/bin/. Either path is a positive match.
  if (entryPath.includes("/.volta/")) return "volta";
  // Bun's global registry: ~/.bun/install/global/node_modules/@paneui/cli/...
  if (entryPath.includes("/.bun/install/global/")) return "bun-global";
  // npm global, in both common shapes:
  //   /usr/(local/)?lib/node_modules/@paneui/cli/...  (system)
  //   ~/.npm-global/lib/node_modules/@paneui/cli/...   (npm prefix)
  //   ~/.nvm/versions/node/vXX/lib/node_modules/...    (nvm)
  if (
    /\/lib\/node_modules\/@paneui\/cli\//.test(entryPath) ||
    /\/lib\/node_modules\/\.bin\//.test(entryPath)
  ) {
    return "npm-global";
  }
  // npx caches the package under ~/Library/Caches/_npx (macOS) or
  // ~/.npm/_npx (Linux) and runs it from a node_modules inside that dir.
  // Pane this distinctly from a real vendored install: with an npx
  // execution there is no project package.json owning the version and no
  // global to upgrade — the user runs `npx @paneui/cli@<version>` each
  // time, so the right answer is "ask the human / re-run with a newer
  // explicit version".
  if (entryPath.includes("/_npx/")) return "unknown";
  // Vendored: the CLI lives inside the *project's* node_modules — i.e. the
  // user did `npm i @paneui/cli` (no -g) and runs it via a local script.
  // We can't safely upgrade this for them; package.json owns it.
  if (entryPath.includes("/node_modules/@paneui/cli/")) return "vendored";
  // pnpm temp, asdf, or anything else.
  return "unknown";
}

/**
 * Returns the shell command the human (or the agent, in a sandbox it owns)
 * can run to upgrade @paneui/cli to satisfy `minVersion`. `null` means "no
 * portable command exists — escalate to the human."
 *
 * Always pin the upgrade target to `>=${minVersion}` instead of `@latest`
 * so a self-hosted relay that requires 0.0.7 doesn't drag the client to a
 * future 0.1.0 that may have its own incompatibilities. The trailing
 * `@latest`-equivalent is fine for the operator who deliberately
 * fast-forwards.
 */
export function upgradeCommandFor(
  method: InstallMethod,
  minVersion: string,
): string | null {
  const spec = `@paneui/cli@>=${minVersion}`;
  switch (method) {
    case "npm-global":
      return `npm install -g ${spec}`;
    case "bun-global":
      return `bun install -g ${spec}`;
    case "volta":
      return `volta install ${spec}`;
    case "vendored":
    case "unknown":
      return null;
  }
}

/**
 * The deterministic stderr block the CLI prints on a 426 response. The agent
 * is expected to read this verbatim and (per SKILL.md) run the printed
 * command, then re-run its original `pane` invocation once. Format is held
 * stable across CLI versions so the skill's instructions don't drift — a
 * change here is a contract change.
 */
export function formatUpgradeMessage(
  err: PaneApiError,
  method: InstallMethod,
  command: string | null,
): string {
  // The relay's 426 payload puts the two version strings under details. We
  // tolerate a missing/malformed details object so a misbehaving relay
  // can't crash the CLI's own error path — show whatever we have.
  const details = (err.details ?? {}) as {
    min_version?: unknown;
    your_version?: unknown;
  };
  const minVersion =
    typeof details.min_version === "string" ? details.min_version : "?";
  const yourVersion =
    typeof details.your_version === "string" ? details.your_version : "?";

  const lines: string[] = [];
  lines.push(
    `pane: this relay requires @paneui/cli >= ${minVersion} (you have ${yourVersion}).`,
  );
  if (command !== null) {
    lines.push(`To upgrade: ${command}`);
  } else if (method === "vendored") {
    lines.push(
      "Install method: vendored (inside a project's node_modules). Bump the @paneui/cli version in that project's package.json and re-install — the CLI isn't safe to upgrade globally for a vendored install.",
    );
  } else {
    lines.push(
      "Install method: unknown. Ask the human to upgrade @paneui/cli — the install path didn't match any pattern we recognize (npm-global, bun-global, volta).",
    );
  }
  return lines.join("\n");
}

/**
 * Stable exit code used by the CLI on a `cli_upgrade_required` response.
 * Sysexits.h's `EX_TEMPFAIL` — "temporary failure; retry after fixing".
 * Documented in SKILL.md so an agent's harness can branch on it.
 */
export const EXIT_CLI_UPGRADE_REQUIRED = 75;
