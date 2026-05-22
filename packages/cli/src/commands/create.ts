// `pane session create` — create a session via POST /v1/sessions.

import { createSessionSchema, type CreateSessionRequest } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson, resolveText } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";

// Translate a Zod schema path (e.g. ["participants","humans"]) back to the
// public CLI flag the user actually typed. Without this, a `--participants 0`
// rejection surfaces as `participants.humans: ...` — which leaks the wire
// shape and refers to no flag the user could fix.
//
// Match strategy: longest prefix wins. Schema paths whose top segment isn't
// in the table fall back to dotted notation so we degrade gracefully on
// fields that don't have a single corresponding flag (e.g. `artifact.source`
// — there's no single --artifact-source flag for the inline form, just
// --artifact pointing at the whole blob).
const SCHEMA_PATH_TO_FLAG: Record<string, string> = {
  participants: "--participants",
  "participants.humans": "--participants",
  ttl: "--ttl",
  metadata: "--metadata",
  callback: "--callback",
  input_data: "--input-data",
  title: "--title",
  "artifact.id": "--artifact-id",
  "artifact.version": "--version",
  "artifact.type": "--artifact-type",
  "artifact.source": "--artifact",
  "artifact.event_schema": "--event-schema",
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

export const createHelp = `pane session create — create a Pane session

A session is one use of an artifact. Supply the artifact in ONE of two ways:

  Reference form — instance an existing reusable artifact (the cheap path,
  no HTML re-sent):
    pane session create --artifact-id <id|slug> [--version <n>] [--input-data <v>]

  Inline form — a one-off artifact, defined on this call:
    pane session create --artifact <path|inline> [--event-schema <path|json>] [options]

Exactly one of --artifact-id / --artifact must be given.

Artifact (choose one):
  --artifact-id <v>   Reference an existing named artifact by id or slug.
                      Tip: run 'pane artifact search <keywords>' first — a
                      suitable artifact may already exist; reuse it instead of
                      regenerating HTML.
  --version <n>       With --artifact-id: pin a specific version. Defaults to
                      the artifact's latest version.
  --artifact <v>      Inline HTML artifact. Either a file path / URL, or inline
                      HTML. Combine with --artifact-type to control reading.
  --event-schema <v>  Inline-form event schema. A .json file, or inline JSON.
                      Optional with --artifact. Omit for a view-only artifact
                      (a report/dashboard the human only views — no page/agent
                      events). Ignored with --artifact-id.

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

Options:
  --title <text>      Tab title shown to the human (max 80 chars, single
                      line). Required, with one ergonomic exception: when
                      --artifact-id references a named artifact, the relay
                      falls back to Artifact.name. Inline (--artifact …) form
                      always needs --title.
  --input-data <v>    This instance's seed data — a JSON object (file path or
                      inline JSON), validated by the relay against the artifact
                      version's input_schema. The page reads it as
                      window.pane.inputData.
  --artifact-type <t> "html-inline" (default) or "html-ref". With "html-ref"
                      the --artifact value is treated as a URL. Note: the relay
                      does not serve "html-ref" artifacts in this release and
                      will reject the session — use "html-inline".
  --ttl <seconds>     Session time-to-live in seconds. The relay clamps this
                      to its configured MAX_TTL_SECONDS (defaults: 1 h
                      requested, 24 h max for self-host; hosted may differ).
                      The returned \`expires_at\` is the authoritative value.
  --participants <n>  Number of human participants (default 1).
  --metadata <path|json>  Arbitrary metadata object (file path or inline JSON).
  --callback <path|json>  Webhook callback config: { url, events[], secret }.
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output (stdout, JSON):
  { session_id, urls, tokens, expires_at }

Deliver urls.humans to the human(s); keep tokens.agent for the WS stream.`;

export async function runCreate(args: ParsedArgs): Promise<void> {
  const artifactIdVal = args.flags.get("artifact-id");
  const artifactVal = args.flags.get("artifact");

  // Exactly one of the two artifact forms must be present.
  if (artifactIdVal !== undefined && artifactVal !== undefined) {
    fail(
      "pass only one of --artifact-id (reference an existing artifact) or --artifact (inline a one-off)",
      "invalid_args",
    );
  }
  if (artifactIdVal === undefined && artifactVal === undefined) {
    fail(
      "missing artifact — pass --artifact-id <id|slug> to reference an existing artifact, or --artifact <path|inline> to inline one",
      "invalid_args",
    );
  }

  // Assemble a candidate request object, then validate the whole thing with
  // the shared Zod schema (single source of truth, matches what the relay
  // expects). Per-field number parsing still happens here so we can give a
  // flag-specific message; the schema then enforces shape and bounds.
  const candidate: Record<string, unknown> = {};

  if (artifactIdVal !== undefined) {
    // Reference form — instance an existing named artifact. --artifact /
    // --event-schema are not needed here.
    const ref: Record<string, unknown> = { id: artifactIdVal };
    const versionRaw = args.flags.get("version");
    if (versionRaw !== undefined) {
      const version = Number(versionRaw);
      if (!Number.isInteger(version) || version < 1) {
        fail("--version must be a positive integer", "invalid_args");
      }
      ref["version"] = version;
    }
    candidate["artifact"] = ref;
  } else {
    // Inline form — the event schema rides inside the `artifact` object; the
    // relay transparently creates an anonymous artifact behind it.
    // --event-schema is optional: omitting it makes a view-only one-off (a
    // report/dashboard the human only views), and the relay then rejects every
    // page/agent emit.
    const schemaVal = args.flags.get("event-schema");

    const artifactType = (args.flags.get("artifact-type") ?? "html-inline") as
      | "html-inline"
      | "html-ref";
    if (artifactType !== "html-inline" && artifactType !== "html-ref") {
      fail(
        "--artifact-type must be 'html-inline' or 'html-ref'",
        "invalid_args",
      );
    }

    // html-ref: the value is a URL, used verbatim. html-inline: file or literal.
    let source: string;
    try {
      source =
        artifactType === "html-ref" ? artifactVal! : resolveText(artifactVal!);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }

    // Build the inline artifact object. event_schema is OMITTED entirely (not
    // set to undefined) when --event-schema is absent — a view-only artifact.
    const inlineArtifact: Record<string, unknown> = {
      type: artifactType,
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
    candidate["artifact"] = inlineArtifact;
  }

  // --title — passthrough, no client-side requiredness. The relay is the
  // single source of truth: it enforces "required, with --artifact-id +
  // Artifact.name as the only fallback" and the shape rules (length, control
  // chars). Keeping all that server-side avoids drift between the CLI's
  // pre-checks and the relay's actual rules.
  const titleRaw = args.flags.get("title");
  if (titleRaw !== undefined) {
    candidate["title"] = titleRaw;
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

  const parsed = createSessionSchema.safeParse(candidate);
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

  const req: CreateSessionRequest = parsed.data;

  const client = makeClient(args);
  try {
    const res = await client.createSession(req);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}
