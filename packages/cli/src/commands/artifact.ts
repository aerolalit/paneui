// `pane artifact` — manage reusable, versioned artifacts.
//
// Flat command namespace: `artifact` is one top-level command that branches on
// a positional subcommand (create / version / update / search / list / show /
// delete).
// An artifact is a reusable UI template (HTML + event schema + optional input
// schema); a session is one *use* of one version of it. Authoring an artifact
// once and instancing it via `pane create --artifact-id` removes the per-use
// cost of regenerating the same HTML.

import {
  createArtifactSchema,
  createArtifactVersionSchema,
  patchArtifactMetadataSchema,
  type CreateArtifactRequest,
  type CreateArtifactVersionRequest,
  type PatchArtifactMetadataRequest,
} from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson, resolveText } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";

export const artifactHelp = `pane artifact — manage reusable, versioned artifacts

An artifact is a reusable UI template: HTML + an event schema + an optional
input schema. A session is one use of one version of it. Author an artifact
once, then instance it many times with 'pane create --artifact-id <id|slug>'
instead of regenerating the HTML on every session.

Usage:
  pane artifact <subcommand> [options]

Subcommands:
  create     Create a named, reusable artifact (its v1).
  version    Append a new version to an existing artifact.
  update     Update an artifact's head metadata (name/slug/description/tags).
  search     Search the agent's named artifacts (lean — no HTML).
  list       List the agent's named artifacts (search with no query).
  show       Show a full artifact: head metadata + its version list.
  delete     Permanently delete an artifact and ALL its versions. Requires
             --yes. Refused with 409 conflict if any session (open or
             closed) still references the artifact — delete those first.

  pane artifact create --name <n> --artifact <path|inline>
                       [--event-schema <path|json>] [--slug <s>]
                       [--description <d>] [--tags <t1,t2>]
                       [--input-schema <path|json>] [--artifact-type <t>]
      Creates a named artifact. Prints { artifact_id, slug, version }.

  pane artifact version <id|slug> --artifact <path|inline>
                        [--event-schema <path|json>]
                        [--input-schema <path|json>] [--artifact-type <t>]
      Appends a new immutable version. Prints { artifact_id, version }.

  pane artifact update <id|slug> [--name <n>] [--slug <s>]
                       [--description <d>] [--tags <t1,t2>]
      Updates head metadata only (never the content). Prints the lean summary.

  pane artifact search [query]
      Text search over name + description + tags, ranked by last_used_at.
      Prints an array of { id, slug, name, description, tags,
      latest_version, last_used_at }.

  pane artifact list
      Alias of 'search' with no query — lists all the agent's artifacts.

  pane artifact show <id|slug>
      Prints the full artifact: head metadata + every version's content.

  pane artifact delete <id|slug> --yes
      Permanently deletes the artifact and all its versions. Refused
      (409 conflict) if any session in any state still references one
      of the artifact's versions — run 'pane delete <session-id>' on
      each first, or wait for the relay's TTL sweeper to reclaim them.
      Prints { artifact, deleted: true } on success.

Options:
  --name <n>          Artifact display name (required for 'create').
  --slug <s>          Stable, agent-chosen handle (unique per agent). The
                      durable way to reference the artifact later.
  --description <d>   Prose: what the artifact is and does. Read by an agent
                      deciding whether to reuse it.
  --tags <t1,t2,...>  Comma-separated keywords for search.
  --artifact <v>      HTML artifact body — a file path, or inline HTML.
  --event-schema <v>  Event schema — a .json file path, or inline JSON.
                      Optional: omit for a view-only artifact (a
                      report/dashboard the human only views — no page/agent
                      events).

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
  --input-schema <v>  JSON Schema for this artifact's per-session input_data —
                      a file path, or inline JSON. Optional.
  --artifact-type <t> "html-inline" (default) or "html-ref".
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output: stdout is machine-readable JSON.`;

/** Resolve --artifact-type, defaulting to html-inline. */
function resolveArtifactType(args: ParsedArgs): "html-inline" | "html-ref" {
  const t = (args.flags.get("artifact-type") ?? "html-inline") as
    | "html-inline"
    | "html-ref";
  if (t !== "html-inline" && t !== "html-ref") {
    fail("--artifact-type must be 'html-inline' or 'html-ref'", "invalid_args");
  }
  return t;
}

/** Resolve the artifact HTML body (file or inline; verbatim URL for html-ref). */
function resolveSource(
  args: ParsedArgs,
  type: "html-inline" | "html-ref",
): string {
  const artifactVal = args.flags.get("artifact");
  if (!artifactVal) fail("missing --artifact", "invalid_args");
  try {
    return type === "html-ref" ? artifactVal : resolveText(artifactVal);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "invalid_args");
  }
}

/**
 * Resolve --event-schema — file path or inline JSON. --event-schema is
 * optional: when absent this returns `undefined`, which makes a view-only
 * artifact (no event vocabulary — the human only views it). The caller must
 * omit `event_schema` from the request entirely when this returns `undefined`.
 */
function resolveEventSchema(args: ParsedArgs): unknown {
  const schemaVal = args.flags.get("event-schema");
  if (!schemaVal) return undefined;
  try {
    return resolveJson(schemaVal, "--event-schema");
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "invalid_args");
  }
}

/** Resolve the optional --input-schema — file path or inline JSON. */
function resolveInputSchema(
  args: ParsedArgs,
): Record<string, unknown> | undefined {
  const raw = args.flags.get("input-schema");
  if (raw === undefined) return undefined;
  try {
    const v = resolveJson(raw, "--input-schema");
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      fail("--input-schema must be a JSON object", "invalid_args");
    }
    return v as Record<string, unknown>;
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "invalid_args");
  }
}

/** Parse a comma-separated --tags flag into a string array. */
function resolveTags(args: ParsedArgs): string[] | undefined {
  const raw = args.flags.get("tags");
  if (raw === undefined) return undefined;
  const tags = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  return tags.length > 0 ? tags : undefined;
}

async function runArtifactCreate(args: ParsedArgs): Promise<void> {
  const name = args.flags.get("name");
  if (!name) fail("missing --name", "invalid_args");

  const type = resolveArtifactType(args);
  const source = resolveSource(args, type);
  const eventSchema = resolveEventSchema(args);
  const inputSchema = resolveInputSchema(args);
  const tags = resolveTags(args);
  const slug = args.flags.get("slug");
  const description = args.flags.get("description");

  const candidate: Record<string, unknown> = {
    name,
    source,
    type,
  };
  // event_schema is OMITTED entirely when --event-schema is absent — a view-only
  // artifact. Setting it to `undefined` would still add the key.
  if (eventSchema !== undefined) candidate["event_schema"] = eventSchema;
  if (slug !== undefined) candidate["slug"] = slug;
  if (description !== undefined) candidate["description"] = description;
  if (tags !== undefined) candidate["tags"] = tags;
  if (inputSchema !== undefined) candidate["input_schema"] = inputSchema;

  const parsed = createArtifactSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue && issue.path.length > 0 ? issue.path.join(".") : "request";
    fail(
      `invalid artifact: ${where}: ${issue ? issue.message : "validation failed"}`,
      "invalid_args",
      parsed.error.flatten(),
    );
  }

  const req: CreateArtifactRequest = parsed.data;
  const client = makeClient(args);
  try {
    const res = await client.createArtifact(req);
    printJson({
      artifact_id: res.artifact_id,
      slug: slug ?? null,
      version: res.version,
    });
  } catch (e) {
    failFromError(e);
  }
}

async function runArtifactVersion(args: ParsedArgs): Promise<void> {
  const idOrSlug = args.positionals[1];
  if (!idOrSlug) {
    fail(
      "missing artifact <id|slug> — usage: pane artifact version <id|slug>",
      "invalid_args",
    );
  }

  const type = resolveArtifactType(args);
  const source = resolveSource(args, type);
  const eventSchema = resolveEventSchema(args);
  const inputSchema = resolveInputSchema(args);

  const candidate: Record<string, unknown> = {
    source,
    type,
  };
  // event_schema is OMITTED entirely when --event-schema is absent — a view-only
  // version. Setting it to `undefined` would still add the key.
  if (eventSchema !== undefined) candidate["event_schema"] = eventSchema;
  if (inputSchema !== undefined) candidate["input_schema"] = inputSchema;

  const parsed = createArtifactVersionSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue && issue.path.length > 0 ? issue.path.join(".") : "request";
    fail(
      `invalid version: ${where}: ${issue ? issue.message : "validation failed"}`,
      "invalid_args",
      parsed.error.flatten(),
    );
  }

  const req: CreateArtifactVersionRequest = parsed.data;
  const client = makeClient(args);
  try {
    const res = await client.createArtifactVersion(idOrSlug, req);
    printJson({ artifact_id: res.artifact_id, version: res.version });
  } catch (e) {
    failFromError(e);
  }
}

async function runArtifactUpdate(args: ParsedArgs): Promise<void> {
  const idOrSlug = args.positionals[1];
  if (!idOrSlug) {
    fail(
      "missing artifact <id|slug> — usage: pane artifact update <id|slug>",
      "invalid_args",
    );
  }

  const candidate: Record<string, unknown> = {};
  const name = args.flags.get("name");
  const slug = args.flags.get("slug");
  const description = args.flags.get("description");
  const tags = resolveTags(args);
  if (name !== undefined) candidate["name"] = name;
  if (slug !== undefined) candidate["slug"] = slug;
  if (description !== undefined) candidate["description"] = description;
  if (tags !== undefined) candidate["tags"] = tags;

  if (Object.keys(candidate).length === 0) {
    fail(
      "nothing to update — pass at least one of --name / --slug / --description / --tags",
      "invalid_args",
    );
  }

  const parsed = patchArtifactMetadataSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue && issue.path.length > 0 ? issue.path.join(".") : "request";
    fail(
      `invalid update: ${where}: ${issue ? issue.message : "validation failed"}`,
      "invalid_args",
      parsed.error.flatten(),
    );
  }

  const metadata: PatchArtifactMetadataRequest = parsed.data;
  const client = makeClient(args);
  try {
    const res = await client.updateArtifact(idOrSlug, metadata);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

async function runArtifactSearch(
  args: ParsedArgs,
  query?: string,
): Promise<void> {
  const client = makeClient(args);
  try {
    const res = await client.searchArtifacts(query);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

async function runArtifactShow(args: ParsedArgs): Promise<void> {
  const idOrSlug = args.positionals[1];
  if (!idOrSlug) {
    fail(
      "missing artifact <id|slug> — usage: pane artifact show <id|slug>",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const res = await client.getArtifact(idOrSlug);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

// `pane artifact delete <id|slug> --yes` — remove an artifact (and, server-
// side, all its versions). The relay refuses with 409 conflict if any
// session still references it; the CLI surfaces that as the relay-supplied
// envelope. `--yes` is required because there's no Undo button on a delete
// and the same `pane artifact create` slug isn't reservable once gone.
async function runArtifactDelete(args: ParsedArgs): Promise<void> {
  const idOrSlug = args.positionals[1];
  if (!idOrSlug) {
    fail(
      "missing artifact <id|slug> — usage: pane artifact delete <id|slug> --yes",
      "invalid_args",
    );
  }
  if (!args.bools.has("yes")) {
    fail(
      "'pane artifact delete' permanently removes the artifact and all its versions — it is destructive. Pass --yes to confirm.",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    await client.deleteArtifact(idOrSlug!);
    printJson({ artifact: idOrSlug, deleted: true });
  } catch (e) {
    failFromError(e);
  }
}

export async function runArtifact(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "create":
      await runArtifactCreate(args);
      break;
    case "version":
      await runArtifactVersion(args);
      break;
    case "update":
      await runArtifactUpdate(args);
      break;
    case "search":
      await runArtifactSearch(args, args.positionals[1]);
      break;
    case "list":
      await runArtifactSearch(args, undefined);
      break;
    case "show":
      await runArtifactShow(args);
      break;
    case "delete":
      await runArtifactDelete(args);
      break;
    case undefined:
      fail(
        "missing subcommand — usage: pane artifact <create|version|update|search|list|show|delete> (run 'pane artifact --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown artifact subcommand '${sub}' — expected create|version|update|search|list|show|delete (run 'pane artifact --help')`,
        "invalid_args",
      );
  }
}
