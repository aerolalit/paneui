// stdout/stderr helpers. The CLI is JSON-by-default: machine-readable on
// stdout, human errors on stderr.

import { PaneApiError } from "@paneui/core";

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
  if (err instanceof PaneApiError) {
    fail(err.message, err.code, err.details, {
      hint: err.hint,
      retryable: err.retryable,
      docs_url: err.docsUrl,
    });
  }
  fail(err instanceof Error ? err.message : String(err), "internal");
}
