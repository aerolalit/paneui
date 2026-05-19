// `pane create` — create a session via POST /v1/sessions.

import { createSessionSchema, type CreateSessionRequest } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson, resolveText } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";

export const createHelp = `pane create — create a Pane session

A session is one use of an artifact. Supply the artifact in ONE of two ways:

  Reference form — instance an existing reusable artifact (the cheap path,
  no HTML re-sent):
    pane create --artifact-id <id|slug> [--version <n>] [--input-data <v>]

  Inline form — a one-off artifact, defined on this call:
    pane create --artifact <path|inline> [--event-schema <path|json>] [options]

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
      issue && issue.path.length > 0 ? issue.path.join(".") : "request";
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
