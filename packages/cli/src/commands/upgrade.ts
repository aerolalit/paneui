// `pane upgrade <pane-id>` — re-pin a live pane to another version of its
// template, swapping design + content in place (#267).

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

const KNOWN_FLAGS: string[] = ["template-version"];
const KNOWN_BOOLS: string[] = ["force"];

export const upgradeHelp = `pane upgrade — re-pin a live pane to another template version

Usage:
  pane upgrade <pane-id> [--template-version <n>] [--force]

Re-points an existing, live pane at a different version of the SAME template
(POST /v1/panes/:id/upgrade). This swaps the pane's HTML (design) and its
event/input/record schemas (content contract) in place — the human keeps the
same URL, no new pane is created. Use it after appending a new template
version with 'pane template version <id|slug> --template ...'.

Events already on disk are never rewritten — each keeps the template version
it was authored under, so the prior history still renders.

By default the relay runs a strict schema-compat gate: if the target version's
schema narrows the pane's current one (a removed collection, a newly-required
field, a tightened type), the upgrade is refused with a
'schema_incompatible_upgrade' error whose details.breaks lists what would
break. Pass --force to apply the upgrade anyway, accepting that events written
under the old schema may no longer validate.

Note: the re-pin takes effect on the relay immediately and emits a
'system.template.updated' event, but an already-open pane tab is not
force-reloaded in v1 — the new version renders the next time the URL is loaded.

Options:
  --template-version <n>  Target version number. Defaults to the template's
                          latest version.
  --force                 Override the strict schema-compat gate (compat=force).
  --url <url>             Relay base URL (overrides PANE_URL).
  --api-key <key>         Agent API key (overrides PANE_API_KEY).
  -h, --help              Show this help.

Output (stdout, JSON):
  { pane_id, template_version_id, template_version, upgraded, breaks, compat }`;

export async function runUpgrade(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane upgrade");

  const paneId = args.positionals[0];
  if (!paneId) fail("missing <pane-id>", "invalid_args");

  const opts: { template_version?: number; compat?: "strict" | "force" } = {};

  const versionRaw = args.flags.get("template-version");
  if (versionRaw !== undefined) {
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 1) {
      fail("--template-version must be a positive integer", "invalid_args");
    }
    opts.template_version = version;
  }

  if (args.bools.has("force")) opts.compat = "force";

  const client = makeClient(args);
  try {
    const res = await client.upgradePane(paneId!, opts);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}
