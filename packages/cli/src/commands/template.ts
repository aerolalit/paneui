// `pane template` — manage reusable, versioned templates.
//
// Flat command namespace: `template` is one top-level command that branches on
// a positional subcommand (create / version / update / search / list / show /
// delete).
// An template is a reusable UI template (HTML + event schema + optional input
// schema); a pane is one *use* of one version of it. Authoring an template
// once and instancing it via `pane create --template-id` removes the
// per-use cost of regenerating the same HTML.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  createArtifactSchema,
  createArtifactVersionSchema,
  patchArtifactMetadataSchema,
  validateIconEmoji,
  type CreateArtifactRequest,
  type CreateArtifactVersionRequest,
  type PatchArtifactMetadataRequest,
} from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson, resolveText } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";

const CREATE_FLAGS = [
  "name",
  "slug",
  "description",
  "tags",
  "template",
  "template-type",
  "event-schema",
  "input-schema",
  "icon-emoji",
];
const SET_ICON_FLAGS = ["template-id", "emoji", "image"];
const SET_ICON_BOOLS = ["clear"];
const VERSION_FLAGS = [
  "template",
  "template-type",
  "event-schema",
  "input-schema",
];
const UPDATE_FLAGS = ["name", "slug", "description", "tags"];
const NO_FLAGS: string[] = [];
const NO_BOOLS: string[] = [];
const DELETE_BOOLS = ["yes"];
const PUBLISH_FLAGS = ["scopes"];
const SEARCH_PUBLIC_FLAGS = ["limit", "offset"];

export const artifactHelp = `pane template — manage reusable, versioned templates

An template is a reusable UI template: HTML + an event schema + an optional
input schema. A pane is one use of one version of it. Author an template
once, then instance it many times with 'pane create --template-id <id|slug>'
instead of regenerating the HTML on every pane.

Usage:
  pane template <subcommand> [options]

Subcommands:
  create        Create a named, reusable template (its v1).
  version       Append a new version to an existing template.
  update        Update an template's head metadata (name/slug/description/tags).
  search        Search the agent's named templates (lean — no HTML).
  list          List the agent's named templates (search with no query).
  show          Show a full template: head metadata + its version list.
  delete        Permanently delete an template and ALL its versions. Requires
                --yes. Refused with 409 conflict if any pane (open or
                closed) still references the template — delete those first.
  publish       Publish a template to the public catalog (so other humans
                can install it). Optionally lock --scopes at publish time.
  unpublish     Remove a template from the public catalog. Existing
                installs are unaffected; the template just stops appearing
                in searches.
  search-public Search the PUBLIC catalog of all published templates from
                every agent. Use before creating a new template, to find
                an existing one you can install/recommend instead.
  set-icon      Set (or clear) a template's icon — a single emoji, or an
                uploaded raster image (png/jpeg/webp/gif). No SVG, no URLs.

  pane template create --name <n> --template <path|inline>
                       [--event-schema <path|json>] [--slug <s>]
                       [--description <d>] [--tags <t1,t2>]
                       [--input-schema <path|json>] [--template-type <t>]
                       [--icon-emoji <emoji>]
      Creates a named template. Prints { template_id, slug, version }.
      --icon-emoji sets a single-emoji icon at create time; use 'set-icon'
      with --image to attach an uploaded image icon afterwards.

  pane template version <id|slug> --template <path|inline>
                        [--event-schema <path|json>]
                        [--input-schema <path|json>] [--template-type <t>]
      Appends a new immutable version. Prints { template_id, version }.

  pane template update <id|slug> [--name <n>] [--slug <s>]
                       [--description <d>] [--tags <t1,t2>]
      Updates head metadata only (never the content). Prints the lean summary.

  pane template search [query]
      Text search over name + description + tags, ranked by last_used_at.
      Prints an array of { id, slug, name, description, tags,
      latest_version, last_used_at }.

  pane template list
      Alias of 'search' with no query — lists all the agent's templates.

  pane template show <id|slug>
      Prints the full template: head metadata + every version's content.

  pane template delete <id|slug> --yes
      Permanently deletes the template and all its versions. Refused
      (409 conflict) if any pane in any state still references one
      of the template's versions — run 'pane delete <pane-id>' on
      each first, or wait for the relay's TTL sweeper to reclaim them.
      Prints { template, deleted: true } on success.

  pane template publish <id|slug> [--scopes <s1,s2,...>]
      Publishes the template to the public catalog. Other humans can then
      install it from their /apps page. --scopes is a comma-separated
      'verb:noun' list (e.g. 'read:agent,write:pane') that locks the
      permissions this version requests; reissue with new --scopes to
      reset them. Prints the head metadata + published_at + scopes.

  pane template unpublish <id|slug>
      Removes the template from the public catalog. Existing installs
      keep working — they're pinned to their version. Prints the head
      metadata with published_at: null.

  pane template search-public [query] [--limit <n>] [--offset <n>]
      Searches the PUBLIC catalog across every agent's published
      templates. Substring match on name, description, and tags. Ranked
      by install_count desc, then publish recency. Useful BEFORE
      authoring: 'pane template search-public pr-review' may find an
      existing one you can install instead of building from scratch.
      Prints { items, total, offset, limit }.

  pane template set-icon --template-id <id> (--emoji <e> | --image <path>)
  pane template set-icon --template-id <id> --clear
      Sets the template's icon. Pass exactly one of:
        --emoji <e>    a single emoji grapheme (rendered inline as text)
        --image <path> a local raster image (png/jpeg/webp/gif). Uploaded as
                       a template-scoped attachment, then linked as the icon.
        --clear        removes both the emoji and the image icon.
      Image icons are served same-origin from the relay; external URLs and
      SVG are never accepted. Prints the updated lean template summary.

Options:
  --name <n>          Template display name (required for 'create').
  --slug <s>          Stable, agent-chosen handle (unique per agent). The
                      durable way to reference the template later.
  --description <d>   Prose: what the template is and does. Read by an agent
                      deciding whether to reuse it.
  --tags <t1,t2,...>  Comma-separated keywords for search.
  --template <v>      HTML template body — a file path, or inline HTML.
  --event-schema <v>  Event schema — a .json file path, or inline JSON.
                      Optional: omit for a view-only template (a
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
  --input-schema <v>  JSON Schema for this template's per-pane input_data —
                      a file path, or inline JSON. Optional.
  --icon-emoji <e>    Single-emoji icon for the template (create only).
  --template-type <t> "html-inline" (default) or "html-ref".
  --url <url>         Relay base URL (overrides PANE_URL).
  --api-key <key>     Agent API key (overrides PANE_API_KEY).
  -h, --help          Show this help.

Output: stdout is machine-readable JSON.`;

/** Resolve --template-type, defaulting to html-inline. */
function resolveArtifactType(args: ParsedArgs): "html-inline" | "html-ref" {
  const t = (args.flags.get("template-type") ?? "html-inline") as
    | "html-inline"
    | "html-ref";
  if (t !== "html-inline" && t !== "html-ref") {
    fail("--template-type must be 'html-inline' or 'html-ref'", "invalid_args");
  }
  return t;
}

/** Resolve the template HTML body (file or inline; verbatim URL for html-ref). */
function resolveSource(
  args: ParsedArgs,
  type: "html-inline" | "html-ref",
): string {
  const artifactVal = args.flags.get("template");
  if (!artifactVal) fail("missing --template", "invalid_args");
  try {
    return type === "html-ref" ? artifactVal : resolveText(artifactVal);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "invalid_args");
  }
}

/**
 * Resolve --event-schema — file path or inline JSON. --event-schema is
 * optional: when absent this returns `undefined`, which makes a view-only
 * template (no event vocabulary — the human only views it). The caller must
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

async function runTemplateCreate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, CREATE_FLAGS, NO_BOOLS, "pane template create");

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
  // template. Setting it to `undefined` would still add the key.
  if (eventSchema !== undefined) candidate["event_schema"] = eventSchema;
  if (slug !== undefined) candidate["slug"] = slug;
  if (description !== undefined) candidate["description"] = description;
  if (tags !== undefined) candidate["tags"] = tags;
  if (inputSchema !== undefined) candidate["input_schema"] = inputSchema;
  const iconEmoji = args.flags.get("icon-emoji");
  if (iconEmoji !== undefined) candidate["icon_emoji"] = iconEmoji;

  const parsed = createArtifactSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue && issue.path.length > 0 ? issue.path.join(".") : "request";
    fail(
      `invalid template: ${where}: ${issue ? issue.message : "validation failed"}`,
      "invalid_args",
      parsed.error.flatten(),
    );
  }

  const req: CreateArtifactRequest = parsed.data;
  const client = makeClient(args);
  try {
    const res = await client.createArtifact(req);
    printJson({
      template_id: res.template_id,
      slug: slug ?? null,
      version: res.version,
    });
  } catch (e) {
    failFromError(e);
  }
}

async function runTemplateVersion(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, VERSION_FLAGS, NO_BOOLS, "pane template version");

  const idOrSlug = args.positionals[1];
  if (!idOrSlug) {
    fail(
      "missing template <id|slug> — usage: pane template version <id|slug>",
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
    printJson({ template_id: res.template_id, version: res.version });
  } catch (e) {
    failFromError(e);
  }
}

async function runTemplateUpdate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, UPDATE_FLAGS, NO_BOOLS, "pane template update");

  const idOrSlug = args.positionals[1];
  if (!idOrSlug) {
    fail(
      "missing template <id|slug> — usage: pane template update <id|slug>",
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

async function runTemplateSearch(
  args: ParsedArgs,
  query?: string,
): Promise<void> {
  assertKnownFlags(
    args,
    NO_FLAGS,
    NO_BOOLS,
    query === undefined ? "pane template list" : "pane template search",
  );

  const client = makeClient(args);
  try {
    const res = await client.searchArtifacts(query);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

async function runTemplateShow(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, NO_BOOLS, "pane template show");

  const idOrSlug = args.positionals[1];
  if (!idOrSlug) {
    fail(
      "missing template <id|slug> — usage: pane template show <id|slug>",
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

// `pane template delete <id|slug> --yes` — remove an template (and, server-
// side, all its versions). The relay refuses with 409 conflict if any
// pane still references it; the CLI panes that as the relay-supplied
// envelope. `--yes` is required because there's no Undo button on a delete
// and the same `pane template create` slug isn't reservable once gone.
async function runTemplateDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, DELETE_BOOLS, "pane template delete");

  const idOrSlug = args.positionals[1];
  if (!idOrSlug) {
    fail(
      "missing template <id|slug> — usage: pane template delete <id|slug> --yes",
      "invalid_args",
    );
  }
  if (!args.bools.has("yes")) {
    fail(
      "'pane template delete' permanently removes the template and all its versions — it is destructive. Pass --yes to confirm.",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    await client.deleteArtifact(idOrSlug!);
    printJson({ template: idOrSlug, deleted: true });
  } catch (e) {
    failFromError(e);
  }
}

async function runTemplatePublish(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, PUBLISH_FLAGS, NO_BOOLS, "pane template publish");

  const idOrSlug = args.positionals[1];
  if (!idOrSlug) {
    fail(
      "missing template <id|slug> — usage: pane template publish <id|slug> [--scopes <s1,s2,...>]",
      "invalid_args",
    );
  }

  // --scopes is a comma-separated list of verb:noun strings. Omit to leave
  // the existing scopes alone (server semantics). Pass an empty string to
  // explicitly clear them (we send []).
  const rawScopes = args.flags.get("scopes");
  const body: { scopes?: string[] } = {};
  if (rawScopes !== undefined) {
    body.scopes = rawScopes
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const client = makeClient(args);
  try {
    const res = await client.publishTemplate(idOrSlug, body);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

async function runTemplateUnpublish(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, NO_FLAGS, NO_BOOLS, "pane template unpublish");

  const idOrSlug = args.positionals[1];
  if (!idOrSlug) {
    fail(
      "missing template <id|slug> — usage: pane template unpublish <id|slug>",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const res = await client.unpublishTemplate(idOrSlug);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

async function runTemplateSearchPublic(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    SEARCH_PUBLIC_FLAGS,
    NO_BOOLS,
    "pane template search-public",
  );

  const query = args.positionals[1];
  const opts: { limit?: number; offset?: number } = {};
  const limitRaw = args.flags.get("limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      fail("--limit must be an integer between 1 and 50", "invalid_args");
    }
    opts.limit = n;
  }
  const offsetRaw = args.flags.get("offset");
  if (offsetRaw !== undefined) {
    const n = Number(offsetRaw);
    if (!Number.isInteger(n) || n < 0) {
      fail("--offset must be a non-negative integer", "invalid_args");
    }
    opts.offset = n;
  }

  const client = makeClient(args);
  try {
    const res = await client.searchPublicTemplates(query, opts);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

// `pane template set-icon --template-id <id> (--emoji <e> | --image <path> |
// --clear)` — set or clear a template's icon. --emoji PATCHes icon_emoji
// directly; --image uploads the file as a template-scoped attachment then
// PATCHes icon_attachment_id; --clear nulls both.
async function runTemplateSetIcon(args: ParsedArgs): Promise<void> {
  assertKnownFlags(
    args,
    SET_ICON_FLAGS,
    SET_ICON_BOOLS,
    "pane template set-icon",
  );

  const templateId = args.flags.get("template-id");
  if (!templateId) {
    fail(
      "missing --template-id <id> — usage: pane template set-icon --template-id <id> (--emoji <e> | --image <path> | --clear)",
      "invalid_args",
    );
  }

  const emoji = args.flags.get("emoji");
  const imagePath = args.flags.get("image");
  const clear = args.bools.has("clear");

  // Exactly one of --emoji / --image / --clear.
  const chosen = [emoji !== undefined, imagePath !== undefined, clear].filter(
    Boolean,
  ).length;
  if (chosen !== 1) {
    fail(
      "pass exactly one of --emoji <e>, --image <path>, or --clear",
      "invalid_args",
    );
  }

  const client = makeClient(args);

  if (clear) {
    try {
      const res = await client.updateArtifact(templateId!, {
        icon_emoji: null,
        icon_attachment_id: null,
      });
      printJson(res);
    } catch (e) {
      failFromError(e);
    }
    return;
  }

  if (emoji !== undefined) {
    // Validate client-side for a clear error before the round trip; the relay
    // re-validates regardless.
    const v = validateIconEmoji(emoji);
    if (!v.ok) fail(`invalid --emoji: ${v.error}`, "invalid_args");
    try {
      const res = await client.updateArtifact(templateId!, {
        icon_emoji: emoji,
      });
      printJson(res);
    } catch (e) {
      failFromError(e);
    }
    return;
  }

  // --image: upload the file as a template-scoped attachment, then link it.
  let bytes: Buffer;
  try {
    bytes = readFileSync(imagePath!);
  } catch (e) {
    fail(
      `failed to read --image '${imagePath}': ${e instanceof Error ? e.message : String(e)}`,
      "invalid_args",
    );
  }
  try {
    const ref = await client.uploadBlob(bytes!, {
      scope: "template",
      templateId: templateId!,
      filename: basename(imagePath!),
    });
    const res = await client.updateArtifact(templateId!, {
      icon_attachment_id: ref.attachment_id,
    });
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

export async function runTemplate(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "create":
      await runTemplateCreate(args);
      break;
    case "version":
      await runTemplateVersion(args);
      break;
    case "update":
      await runTemplateUpdate(args);
      break;
    case "search":
      await runTemplateSearch(args, args.positionals[1]);
      break;
    case "list":
      await runTemplateSearch(args, undefined);
      break;
    case "show":
      await runTemplateShow(args);
      break;
    case "delete":
      await runTemplateDelete(args);
      break;
    case "publish":
      await runTemplatePublish(args);
      break;
    case "unpublish":
      await runTemplateUnpublish(args);
      break;
    case "search-public":
      await runTemplateSearchPublic(args);
      break;
    case "set-icon":
      await runTemplateSetIcon(args);
      break;
    case undefined:
      fail(
        "missing subcommand — usage: pane template <create|version|update|search|list|show|delete|publish|unpublish|search-public|set-icon> (run 'pane template --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown template subcommand '${sub}' — expected create|version|update|search|list|show|delete|publish|unpublish|search-public|set-icon (run 'pane template --help')`,
        "invalid_args",
      );
  }
}
