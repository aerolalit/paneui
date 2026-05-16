// Tiny hand-rolled argv parser. No CLI framework.
//
// Supports:
//   --flag value      --flag=value      --bool      -h
// Everything that isn't a flag (or a flag's value) is a positional.

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

/** Thrown when a value-flag is given with no argument (e.g. trailing `--url`). */
export class ArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgvError";
  }
}

/**
 * Parse argv tokens. `booleanFlags` lists flags that never consume a value
 * (e.g. --json, --once, --help); everything else with a `--name` form
 * consumes the next token unless written as `--name=value`.
 */
export function parseArgs(tokens: string[], booleanFlags: Set<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "-h" || tok === "--help") {
      bools.add("help");
      continue;
    }
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (booleanFlags.has(body)) {
        bools.add(body);
        continue;
      }
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        // A value-flag with no argument is a user error — don't silently
        // demote it to a boolean (which hides the mistake).
        throw new ArgvError(`--${body} requires a value`);
      }
      flags.set(body, next);
      i++;
      continue;
    }
    positionals.push(tok);
  }

  return { positionals, flags, bools };
}
