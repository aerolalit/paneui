// stdout/stderr helpers. The CLI is JSON-by-default: machine-readable on
// stdout, human errors on stderr.

import { PaneApiError } from "@pane/core";

/** Print a value as pretty JSON to stdout. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/**
 * Print a single compact JSON line to stdout and flush. Used by `pane watch`
 * so a pipe-reader (e.g. Claude Code's Monitor tool) sees each event
 * immediately, one event per line.
 */
export function printJsonLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

/** Print an error envelope to stderr and exit non-zero. */
export function fail(message: string, code = "error", details?: unknown): never {
  const envelope: Record<string, unknown> = { error: { code, message } };
  if (details !== undefined) {
    (envelope["error"] as Record<string, unknown>)["details"] = details;
  }
  process.stderr.write(JSON.stringify(envelope) + "\n");
  process.exit(1);
}

/** Translate a thrown error (incl. PaneApiError) into a fail() exit. */
export function failFromError(err: unknown): never {
  if (err instanceof PaneApiError) {
    fail(err.message, err.code, err.details);
  }
  fail(err instanceof Error ? err.message : String(err), "internal");
}
