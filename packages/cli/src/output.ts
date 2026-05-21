// stdout/stderr helpers. The CLI is JSON-by-default: machine-readable on
// stdout, human errors on stderr.

import { PaneApiError } from "@paneui/core";
import { fileURLToPath } from "node:url";
import {
  detectInstallMethod,
  upgradeCommandFor,
  formatUpgradeMessage,
  EXIT_CLI_UPGRADE_REQUIRED,
} from "./upgrade.js";

/** Print a value as pretty JSON to stdout. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/**
 * Print a single compact JSON line to stdout and flush. Used by `pane session watch`
 * so a pipe-reader (e.g. Claude Code's Monitor tool) sees each event
 * immediately, one event per line.
 */
export function printJsonLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

/**
 * Agent-friendly extras carried on an error envelope. `docs_url` is snake_case
 * on the wire to match the relay's error shape.
 */
export interface ErrorExtra {
  hint?: string;
  retryable?: boolean;
  docs_url?: string;
}

/** Print an error envelope to stderr and exit non-zero. */
export function fail(
  message: string,
  code = "error",
  details?: unknown,
  extra?: ErrorExtra,
): never {
  const error: Record<string, unknown> = { code, message };
  if (extra?.hint !== undefined) error["hint"] = extra.hint;
  if (extra?.retryable !== undefined) error["retryable"] = extra.retryable;
  if (extra?.docs_url !== undefined) error["docs_url"] = extra.docs_url;
  if (details !== undefined) error["details"] = details;
  process.stderr.write(JSON.stringify({ error }) + "\n");
  process.exit(1);
}

/** Translate a thrown error (incl. PaneApiError) into a fail() exit. */
export function failFromError(err: unknown): never {
  // 426 cli_upgrade_required gets its own dedicated exit path: a
  // human-readable upgrade message on stderr and a stable exit code
  // (sysexits EX_TEMPFAIL = 75) that the SKILL.md instructs the agent's
  // harness to branch on. Everything else falls through to the generic
  // JSON envelope below.
  if (
    err instanceof PaneApiError &&
    err.code === "cli_upgrade_required" &&
    err.status === 426
  ) {
    failUpgradeRequired(err);
  }
  if (err instanceof PaneApiError) {
    fail(err.message, err.code, err.details, {
      hint: err.hint,
      retryable: err.retryable,
      docs_url: err.docsUrl,
    });
  }
  fail(err instanceof Error ? err.message : String(err), "internal");
}

/**
 * Print the upgrade message to stderr and exit 75. Pulled out of
 * failFromError so the top-level main().catch can also funnel through it
 * — the two entry points must produce identical output for the SKILL.md's
 * "if you see exit 75…" instructions to be reliable.
 *
 * The install-method detection reads `import.meta.url` of the CLI entry,
 * resolved from the call site that imports this module. Inlining the
 * resolution here keeps each command's own error-handling free of the
 * detail.
 */
export function failUpgradeRequired(err: PaneApiError): never {
  // The CLI entry is packages/cli/dist/index.js (after build) or
  // packages/cli/src/index.ts (when running from source via tsx). Either
  // way, the detector only looks at the path's shape, so resolving from
  // *this* file works — output.ts sits alongside index.ts/index.js in
  // both layouts.
  const entryPath = fileURLToPath(import.meta.url);
  const method = detectInstallMethod(entryPath);
  const details = (err.details ?? {}) as { min_version?: unknown };
  const minVersion =
    typeof details.min_version === "string" ? details.min_version : "0.0.0";
  const command = upgradeCommandFor(method, minVersion);
  process.stderr.write(formatUpgradeMessage(err, method, command) + "\n");
  process.exit(EXIT_CLI_UPGRADE_REQUIRED);
}
