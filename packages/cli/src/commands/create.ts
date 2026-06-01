// `pane create` — create a pane via POST /v1/panes.

import { createPaneSchema, type CreatePaneRequest } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson, resolveText } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";
import { formatPaneCreated } from "../format.js";

const KNOWN_FLAGS = [
  "template",
  "template-id",
  "template-type",
  "version",
  "event-schema",
  "input-schema",
  "title",
  "preamble",
  "input-data",
  "ttl",
  "participants",
  "metadata",
  "callback",
  "context-key",
];
// `--json` forces machine-readable output even on a TTY. Without it, an
// interactive terminal gets the human-readable form (title + URLs + QR +
// countdown); pipes and `--json` callers still get the legacy JSON shape.
const KNOWN_BOOLS: string[] = ["json"];

// Translate a Zod schema path (e.g. ["participants","humans"]) back to the
// public CLI flag the user actually typed. Without this, a `--participants 0`
// rejection panes as `participants.humans: ...` — which leaks the wire
// shape and refers to no flag the user could fix.
//
// Match strategy: longest prefix wins. Schema paths whose top segment isn't
// in the table fall back to dotted notation so we degrade gracefully on
// fields that don't have a single corresponding flag (e.g. `template.source`
// — there's no single --template-source flag for the inline form, just
// --template pointing at the whole attachment).
const SCHEMA_PATH_TO_FLAG: Record<string, string> = {
  participants: "--participants",
  "participants.humans": "--participants",
  ttl: "--ttl",
  metadata: "--metadata",
  callback: "--callback",
  input_data: "--input-data",
  title: "--title",
  preamble: "--preamble",
  context_key: "--context-key",
  "template.id": "--template-id",
  "template.version": "--version",
  "template.type": "--template-type",
  "template.source": "--template",
  "template.event_schema": "--event-schema",
  "template.input_schema": "--input-schema",
};

function schemaPathToFlag(path: PropertyKey[]): string {
  const dotted = path.map(String).join(".");
  // Longest prefix that has a mapping. Try the full path first, then strip
  // one trailing segment at a time. Falls back to dotted notation as the
  // honest default.
  for (let i = path.length; i > 0; i--) {
    const prefix = path.slice(0, i).map(String).join(".");
    const flag = SCHEMA_PATH_TO_FLAG[prefix];
    if (flag !== undefined) return flag;
  }
  return dotted;
}

export const createHelp = `pane create — create a Pane pane

A pane is one use of an template. Supply the template in ONE of two ways:

  Reference form — instance an existing reusable template (the cheap path,
  no HTML re-sent):
    pane create --template-id <id|slug> [--version <n>] [--input-data <v>]

  Inline form — a one-off template, defined on this call:
    pane create --template <path|inline> [--event-schema <path|json>] [options]

Exactly one of --template-id / --template must be given.

Template (choose one):
  --template-id <v>   Reference an existing named template by id or slug.
                      Tip: run 'pane template search <keywords>' first — a
                      suitable template may already exist; reuse it instead of
                      regenerating HTML.
  --version <n>       With --template-id: pin a specific version. Defaults to
                      the template's latest version.
  --template <v>      Inline HTML template. Either a file path / URL, or inline
                      HTML. Combine with --template-type to control reading.
  --event-schema <v>  Inline-form event schema. A .json file, or inline JSON.
                      Optional with --template. Omit for a view-only template
                      (a report/dashboard the human only views — no page/agent
                      events). Ignored with --template-id.

                      Shape — an object with an "events" map, keyed by event
                      type. Each entry declares who may emit it and the JSON
                      Schema for its payload:
                          {
                            "events": {
                              "form.submitted": {
                                "emittedBy": ["page"],
                                "payload": {
                                  "type": "object",
                                  "properties": { "answer": { "type": "string" } },
                                  "required": ["answer"]
                                }
                              }
                            }
                          }
                      emittedBy is any non-empty subset of ["page", "agent"].
                      payload is a JSON Schema; the relay validates every
                      emit against it. See docs/SPEC.md for the full grammar.
  --input-schema <v>  Inline-form input schema. A .json file, or inline JSON.
                      Optional with --template, rejected with --template-id
                      (the schema comes from the pinned template version
                      there). When present, the pane's --input-data is
                      validated against it AND any attachment ids declared at a
                      "format": "pane-attachment-id" site become reachable from the
                      page via window.pane.downloadBlob. Without it, attachment
                      refs in --input-data are silently unreachable. See
                      docs/SPEC.md and #208.

Options:
  --title <text>      Tab title shown to the human (max 80 chars, single
                      line). Required, with one ergonomic exception: when
                      --template-id references a named template, the relay
                      falls back to Template.name. Inline (--template …) form
                      always needs --title.
  --preamble <text>   Optional one- or two-line context message rendered in
                      the shell band above the iframe — "who is asking, why".
                      Max 280 chars after trim; a single \\n is allowed for a
                      two-line message; other control chars are rejected. Pass
                      this whenever the artifact itself doesn't make the
                      request self-explanatory.
  --input-data <v>    This instance's seed data — a JSON object (file path or
                      inline JSON), validated by the relay against the template
                      version's input_schema. The page reads it as
                      window.pane.inputData.
  --template-type <t> "html-inline" (default) or "html-ref". With "html-ref"
                      the --template value is treated as a URL. Note: the relay
                      does not serve "html-ref" templates in this release and
                      will reject the pane — use "html-inline".
  --ttl <seconds>     Pane time-to-live in seconds. The relay clamps this
                      to its configured MAX_TTL_SECONDS (defaults: 1 h
                      requested, 24 h max for self-host; hosted may differ).
                      The returned \`expires_at\` is the authoritative value.
  --participants <n>  Number of human participants (default 1).
  --metadata <path|json>  Arbitrary metadata object (file path or inline JSON).
  --callback <path|json>  Webhook callback config: { url, events[], secret }.
  --context-key <key>  Natural key for "the same logical thing" — the relay
                      dedups repeated creates with the same
                      (template, owner, context_key) into one pane row,
                      returning {created:false, pane_id:<existing>} on
                      subsequent calls. Use this to make scripted creates
                      idempotent (e.g. "pr-42", "deal-1138", "home"). Only
                      meaningful when the calling agent is claimed by a
                      human; omit otherwise. Allowed chars: A-Za-z0-9_:.-,
                      max 256.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  --json              Force JSON output even on a TTY. Default: JSON when
                      stdout is piped; a human-readable summary (title, URL,
                      QR code, expiry countdown) when stdout is a terminal.
  -h, --help          Show this help.

Output:
  - Piped (or --json): { pane_id, urls, tokens, expires_at } as JSON
  - TTY: title + each human URL + a scannable QR code + expiry countdown

Deliver urls.humans to the human(s); keep tokens.agent for the WS stream.`;

export async function runCreate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane create");

  const artifactIdVal = args.flags.get("template-id");
  const artifactVal = args.flags.get("template");

  // Exactly one of the two template forms must be present.
  if (artifactIdVal !== undefined && artifactVal !== undefined) {
    fail(
      "pass only one of --template-id (reference an existing template) or --template (inline a one-off)",
      "invalid_args",
    );
  }
  if (artifactIdVal === undefined && artifactVal === undefined) {
    fail(
      "missing template — pass --template-id <id|slug> to reference an existing template, or --template <path|inline> to inline one",
      "invalid_args",
    );
  }

  // Assemble a candidate request object, then validate the whole thing with
  // the shared Zod schema (single source of truth, matches what the relay
  // expects). Per-field number parsing still happens here so we can give a
  // flag-specific message; the schema then enforces shape and bounds.
  const candidate: Record<string, unknown> = {};

  if (artifactIdVal !== undefined) {
    // Reference form — instance an existing named template. --template /
    // --event-schema / --input-schema are not used here: the template's
    // pinned version carries them already.
    if (args.flags.get("input-schema") !== undefined) {
      fail(
        "--input-schema is incompatible with --template-id — the input schema comes from the pinned template version. Author the schema on the template (`pane template create --input-schema …`) instead.",
        "invalid_args",
      );
    }
    const ref: Record<string, unknown> = { id: artifactIdVal };
    const versionRaw = args.flags.get("version");
    if (versionRaw !== undefined) {
      const version = Number(versionRaw);
      if (!Number.isInteger(version) || version < 1) {
        fail("--version must be a positive integer", "invalid_args");
      }
      ref["version"] = version;
    }
    candidate["template"] = ref;
  } else {
    // Inline form — the event + input schemas ride inside the `template`
    // object; the relay transparently creates an anonymous template behind
    // it. Both schemas are optional:
    //  - --event-schema absent → view-only one-off (no page/agent emits)
    //  - --input-schema absent → no input contract; --input-data passes
    //    through unvalidated AND any attachment ids in it are unreachable from
    //    the page (the participant attachment-download bridge walks input_data
    //    against the template version's inputSchema). Pass --input-schema
    //    when --input-data carries attachment refs the page needs to render.
    //    See #208.
    const schemaVal = args.flags.get("event-schema");
    const inputSchemaVal = args.flags.get("input-schema");

    const templateType = (args.flags.get("template-type") ?? "html-inline") as
      | "html-inline"
      | "html-ref";
    if (templateType !== "html-inline" && templateType !== "html-ref") {
      fail(
        "--template-type must be 'html-inline' or 'html-ref'",
        "invalid_args",
      );
    }

    // html-ref: the value is a URL, used verbatim. html-inline: file or literal.
    let source: string;
    try {
      source =
        templateType === "html-ref" ? artifactVal! : resolveText(artifactVal!);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }

    // Build the inline template object. event_schema / input_schema are
    // OMITTED entirely (not set to undefined) when their flags are absent —
    // omission is meaningful at the relay (view-only template / no input
    // contract).
    const inlineArtifact: Record<string, unknown> = {
      type: templateType,
      source,
    };
    if (schemaVal !== undefined) {
      try {
        inlineArtifact["event_schema"] = resolveJson(
          schemaVal,
          "--event-schema",
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e), "invalid_args");
      }
    }
    if (inputSchemaVal !== undefined) {
      try {
        const v = resolveJson(inputSchemaVal, "--input-schema");
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
          fail("--input-schema must be a JSON object", "invalid_args");
        }
        inlineArtifact["input_schema"] = v;
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e), "invalid_args");
      }
    }
    candidate["template"] = inlineArtifact;
  }

  // --title — passthrough, no client-side requiredness. The relay is the
  // single source of truth: it enforces "required, with --template-id +
  // Template.name as the only fallback" and the shape rules (length, control
  // chars). Keeping all that server-side avoids drift between the CLI's
  // pre-checks and the relay's actual rules.
  const titleRaw = args.flags.get("title");
  if (titleRaw !== undefined) {
    candidate["title"] = titleRaw;
  }

  // --preamble — passthrough. The relay trims, normalises CRLF, enforces
  // ≤280 chars and rejects non-newline control chars; mirroring those
  // checks here would just create drift on edge cases.
  const preambleRaw = args.flags.get("preamble");
  if (preambleRaw !== undefined) {
    candidate["preamble"] = preambleRaw;
  }

  // --input-data — per-instance seed data, applies to either form (the relay
  // validates it against the pinned version's input_schema).
  const inputDataRaw = args.flags.get("input-data");
  if (inputDataRaw !== undefined) {
    try {
      candidate["input_data"] = resolveJson(inputDataRaw, "--input-data");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }
  }

  const ttlRaw = args.flags.get("ttl");
  if (ttlRaw !== undefined) {
    const ttl = Number(ttlRaw);
    if (!Number.isFinite(ttl)) fail("--ttl must be a number", "invalid_args");
    candidate["ttl"] = ttl;
  }

  const partRaw = args.flags.get("participants");
  if (partRaw !== undefined) {
    const humans = Number(partRaw);
    if (!Number.isFinite(humans))
      fail("--participants must be a number", "invalid_args");
    candidate["participants"] = { humans };
  }

  const metaRaw = args.flags.get("metadata");
  if (metaRaw !== undefined) {
    try {
      candidate["metadata"] = resolveJson(metaRaw, "--metadata");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }
  }

  const cbRaw = args.flags.get("callback");
  if (cbRaw !== undefined) {
    try {
      candidate["callback"] = resolveJson(cbRaw, "--callback");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }
  }

  // --context-key — natural-key dedup. Passthrough; the relay enforces
  // length + charset (createPaneSchema in @paneui/core), so an invalid
  // value panes as a schema rejection on the call below rather than
  // a duplicated client-side guard that could drift.
  const contextKey = args.flags.get("context-key");
  if (contextKey !== undefined) {
    candidate["context_key"] = contextKey;
  }

  const parsed = createPaneSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue && issue.path.length > 0 ? schemaPathToFlag(issue.path) : "request";
    fail(
      `invalid create request: ${where}: ${issue ? issue.message : "validation failed"}`,
      "invalid_args",
      parsed.error.flatten(),
    );
  }

  const req: CreatePaneRequest = parsed.data;

  const client = makeClient(args);
  try {
    const res = await client.createPane(req);
    // Output mode:
    //   --json explicit         → JSON
    //   stdout NOT a TTY (pipe) → JSON (so scripts / agents stay parseable)
    //   stdout IS a TTY         → human-readable (URL + QR + countdown)
    // The TTY check matches the existing `pane taste` / `pane feedback`
    // pattern: agents are non-interactive, humans are.
    const forceJson = args.bools.has("json");
    const isTty = Boolean(process.stdout.isTTY);
    if (forceJson || !isTty) {
      printJson(res);
    } else {
      process.stdout.write(formatPaneCreated(res, { color: isTty }));
    }
  } catch (e) {
    failFromError(e);
  }
}
