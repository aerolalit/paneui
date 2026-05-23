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

/**
 * Thrown for any argv-level user error: missing value, duplicate flag, or
 * (when a runner calls assertKnownFlags) an unknown flag. `hint` rides
 * alongside the message and ends up in the error envelope so callers see a
 * single line pointing them at the right --help.
 */
export class ArgvError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ArgvError";
    if (hint !== undefined) this.hint = hint;
  }
}

/**
 * Parse argv tokens. `booleanFlags` lists flags that never consume a value
 * (e.g. --json, --once, --help); everything else with a `--name` form
 * consumes the next token unless written as `--name=value`.
 *
 * Bails with ArgvError on the first duplicate (`--foo x --foo y` or
 * `--once --once`) so a typo'd repeat doesn't silently overwrite the first
 * value the way a plain `Map.set` would.
 */
export function parseArgs(
  tokens: string[],
  booleanFlags: Set<string>,
): ParsedArgs {
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
        const key = body.slice(0, eq);
        if (flags.has(key)) {
          throw new ArgvError(`duplicate flag: --${key}`);
        }
        flags.set(key, body.slice(eq + 1));
        continue;
      }
      if (booleanFlags.has(body)) {
        if (bools.has(body)) {
          throw new ArgvError(`duplicate flag: --${body}`);
        }
        bools.add(body);
        continue;
      }
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        // A value-flag with no argument is a user error — don't silently
        // demote it to a boolean (which hides the mistake).
        throw new ArgvError(`--${body} requires a value`);
      }
      if (flags.has(body)) {
        throw new ArgvError(`duplicate flag: --${body}`);
      }
      flags.set(body, next);
      i++;
      continue;
    }
    positionals.push(tok);
  }

  return { positionals, flags, bools };
}

/**
 * Flags every command accepts. Kept here (not in each command's allow-list)
 * so adding a new global flag updates one place. `url` / `api-key` are the
 * relay-target overrides; `help` / `json` are universal display modes.
 */
const GLOBAL_FLAGS: readonly string[] = ["url", "api-key"];
const GLOBAL_BOOLS: readonly string[] = ["help", "json"];

/**
 * Reject anything the per-command allow-list (plus the globals above) does
 * not name. Run from each leaf runner before it starts pulling values out of
 * `args`. The thrown ArgvError carries a hint pointing at the verb's own
 * --help, so a user fixing a typo lands on the canonical list of flags.
 *
 * Why per-command and not at parse time: the parser is single-pass and
 * generic on purpose — adding a new flag to one verb should not require a
 * shared registry. Keeping the allow-list co-located with the runner that
 * consumes it means the two cannot drift.
 */
export function assertKnownFlags(
  args: ParsedArgs,
  knownFlags: Iterable<string>,
  knownBools: Iterable<string>,
  helpCommand: string,
): void {
  const flagSet = new Set<string>([...GLOBAL_FLAGS, ...knownFlags]);
  const boolSet = new Set<string>([...GLOBAL_BOOLS, ...knownBools]);
  const unknown: string[] = [];
  for (const k of args.flags.keys()) {
    if (!flagSet.has(k) && !boolSet.has(k)) unknown.push(`--${k}`);
  }
  for (const k of args.bools) {
    if (!boolSet.has(k) && !flagSet.has(k)) unknown.push(`--${k}`);
  }
  if (unknown.length === 0) return;
  throw new ArgvError(
    `unknown flag(s): ${unknown.join(", ")}`,
    `run \`${helpCommand} --help\` for the supported flags`,
  );
}
