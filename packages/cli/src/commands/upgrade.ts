// `pane upgrade <pane-id>` — re-pin a live pane to another version of its
// template, swapping design + content in place (#267).

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson, resolveText } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";

const KNOWN_FLAGS: string[] = [
  "template-version",
  "template",
  "template-type",
  "event-schema",
  "input-schema",
  "record-schema",
  "template-record-schema",
];
const KNOWN_BOOLS: string[] = ["force"];

interface InlineTemplate {
  source: string;
  type?: string;
  event_schema?: unknown;
  input_schema?: Record<string, unknown>;
  record_schema?: unknown;
  template_record_schema?: unknown;
}

export const upgradeHelp = `pane upgrade — re-pin a live pane to another template version

Usage:
  pane upgrade <pane-id> [--template-version <n>] [--force]
  pane upgrade <pane-id> --template <path|inline> [--event-schema <v>] [--force]

Re-points an existing, live pane at a different version of the SAME template
(POST /v1/panes/:id/upgrade). This swaps the pane's HTML (design) and its
event/input/record schemas (content contract) in place — the human keeps the
same URL, no new pane is created.

Two ways to pick the target version:
  • --template-version <n> — re-pin to an existing version. Append it first
    with 'pane template version <id|slug> --template ...'.
  • --template <path|inline> — INLINE EDIT: supply the new HTML directly and the
    relay appends a fresh version + re-pins to it in one call. This is the
    one-shot way to edit an INLINE pane's HTML in place. Any schema you don't
    pass is inherited from the pane's current version, so to change only the
    HTML you pass only --template. Inline panes only (a named/reusable template
    must go through 'pane template version' + --template-version).

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
  --template-version <n>  Re-pin to this existing version. Defaults to the
                          template's latest version. Mutually exclusive with
                          --template.
  --template <v>          INLINE EDIT: new HTML — a file path or inline HTML.
                          Appends a fresh version + re-pins, in one call.
  --template-type <t>     Template type for --template (default: html-inline).
  --event-schema <v>      New event schema for --template (file or inline JSON).
                          Omit to inherit the current version's.
  --input-schema <v>      New input schema for --template (file or inline JSON).
  --record-schema <v>     New record schema for --template (file or inline JSON).
  --template-record-schema <v>  New template-level record schema for --template.
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

  const opts: {
    template_version?: number;
    compat?: "strict" | "force";
    template?: InlineTemplate;
  } = {};

  const versionRaw = args.flags.get("template-version");
  const templateRaw = args.flags.get("template");

  if (versionRaw !== undefined && templateRaw !== undefined) {
    fail(
      "--template and --template-version are mutually exclusive",
      "invalid_args",
    );
  }

  if (versionRaw !== undefined) {
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 1) {
      fail("--template-version must be a positive integer", "invalid_args");
    }
    opts.template_version = version;
  }

  if (templateRaw !== undefined) {
    const tpl: InlineTemplate = { source: resolveText(templateRaw) };
    const type = args.flags.get("template-type");
    if (type !== undefined) tpl.type = type;
    const es = args.flags.get("event-schema");
    if (es !== undefined) tpl.event_schema = resolveJson(es, "--event-schema");
    const is = args.flags.get("input-schema");
    if (is !== undefined)
      tpl.input_schema = resolveJson(is, "--input-schema") as Record<
        string,
        unknown
      >;
    const rs = args.flags.get("record-schema");
    if (rs !== undefined)
      tpl.record_schema = resolveJson(rs, "--record-schema");
    const trs = args.flags.get("template-record-schema");
    if (trs !== undefined)
      tpl.template_record_schema = resolveJson(trs, "--template-record-schema");
    opts.template = tpl;
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
