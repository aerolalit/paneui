// Helpers for reading CLI inputs that may be either a file path or an inline
// literal (JSON, or raw text for an HTML artifact body).

import { readFileSync, existsSync, statSync } from "node:fs";

/** True if `value` names an existing readable file. */
function isFilePath(value: string): boolean {
  try {
    return existsSync(value) && statSync(value).isFile();
  } catch {
    return false;
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
    );
  }
}

/**
 * Resolve raw text that is either a file path or an inline literal — no JSON
 * parsing. Used for an inline HTML artifact body.
 */
export function resolveText(value: string): string {
  return isFilePath(value) ? readFileSync(value, "utf8") : value;
}
