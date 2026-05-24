// Helpers for reading CLI inputs that may be either a file path or an inline
// literal (JSON, or raw text for an HTML template body).

import { readFileSync, statSync } from "node:fs";

/**
 * True if `value` names an existing file. Only a missing path (ENOENT) is
 * treated as "not a file" — any other fs error (EACCES, ELOOP, …) propagates
 * with a labeled message rather than being misreported as inline content.
 */
function isFilePath(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return false;
    }
    const code =
      e && typeof e === "object" ? (e as { code?: string }).code : undefined;
    throw new Error(
      `cannot stat '${value}'${code ? ` (${code})` : ""}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { cause: e },
    );
  }
}

/**
 * Resolve a value that is either a file path or an inline JSON literal.
 * Returns the parsed JSON. Throws on parse failure.
 */
export function resolveJson(value: string, label: string): unknown {
  const raw = isFilePath(value) ? readFileSync(value, "utf8") : value;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${label}: not valid JSON (${e instanceof Error ? e.message : String(e)})`,
      { cause: e },
    );
  }
}

/**
 * Resolve raw text that is either a file path or an inline literal — no JSON
 * parsing. Used for an inline HTML template body.
 */
export function resolveText(value: string): string {
  return isFilePath(value) ? readFileSync(value, "utf8") : value;
}
