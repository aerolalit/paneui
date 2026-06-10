// `pane update <pane-id>` — in-place edit of instance-level pane fields (#502)
// via PATCH /v1/panes/:id. Mirrors the create flags for the editable subset
// (everything that is per-pane rather than per-template).

import { updatePaneSchema, type UpdatePaneRequest } from "@paneui/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { makeClient } from "../config.js";
import { resolveJson } from "../input.js";
import { printJson, fail, failFromError } from "../output.js";

const KNOWN_FLAGS = [
  "ttl",
  "expires-at",
  "input-data",
  "title",
  "preamble",
  "metadata",
  "tags",
  "icon-emoji",
  "icon-attachment-id",
];
// `--clear-icon-emoji` / `--clear-icon-attachment-id` set the corresponding
// field to `null` on the wire (drops the per-pane override; the pane falls back
// to the template's icon).
const KNOWN_BOOLS: string[] = ["clear-icon-emoji", "clear-icon-attachment-id"];

const SCHEMA_PATH_TO_FLAG: Record<string, string> = {
  ttl: "--ttl",
  expires_at: "--expires-at",
  input_data: "--input-data",
  title: "--title",
  preamble: "--preamble",
  metadata: "--metadata",
  tags: "--tags",
  icon_emoji: "--icon-emoji",
  icon_attachment_id: "--icon-attachment-id",
};

function schemaPathToFlag(path: PropertyKey[]): string {
  const dotted = path.map(String).join(".");
  for (let i = path.length; i > 0; i--) {
    const prefix = path.slice(0, i).map(String).join(".");
    const flag = SCHEMA_PATH_TO_FLAG[prefix];
    if (flag !== undefined) return flag;
  }
  return dotted;
}

export const updateHelp = `pane update — edit instance-level fields on a live pane

Usage:
  pane update <pane-id> [options]

Edits a live pane in place (PATCH /v1/panes/:id). The pane keeps its id, URL,
event log, and template pin — only the per-instance fields listed below change.
Pass at least one flag; ttl and --expires-at are mutually exclusive.

The relay revalidates --input-data against the pane's current template
version's input_schema (the pane may have been upgraded since create), and
runs the same attachment-access checks as 'pane create'.

Lifecycle:
  --ttl <seconds>         Reset the pane's lifetime to now + <seconds>. Clamped
                          against the relay's MAX_TTL_SECONDS cap; exceeding it
                          is rejected (not silently truncated).
  --expires-at <iso>      Set expires_at to a specific ISO-8601 timestamp.
                          Must be in the future and within MAX_TTL_SECONDS
                          from now. Mutually exclusive with --ttl.

Display:
  --title <text>          New tab title. Same length/control-char rules as
                          create.
  --preamble <text>       New preamble (the context band above the iframe).
                          Max 280 chars after trim; one \\n permitted.
  --icon-emoji <e>        Set per-pane icon to a single emoji grapheme.
  --icon-attachment-id <id>
                          Set per-pane icon to a ready raster-image
                          attachment (png/jpeg/webp/gif).
  --clear-icon-emoji      Clear the emoji override; fall back to the
                          template's icon.
  --clear-icon-attachment-id
                          Clear the attachment override; fall back to the
                          template's icon.

Data:
  --input-data <path|json>  Replace the pane's input_data wholesale (JSON file
                          path or inline JSON). Revalidated against the pinned
                          template version's input_schema.
  --metadata <path|json>  Replace the pane's metadata wholesale.
  --tags <t1,t2,...>      Replace the per-pane tags (the relay merges them with
                          the template's tags, deduped). ≤20 tags, ≤50 chars
                          each; 'favorite' / 'favorites' are reserved.

Other:
  --url <url>             Relay base URL (overrides PANE_URL).
  --api-key <key>         Agent API key (overrides PANE_API_KEY).
  -h, --help              Show this help.

Output (stdout, JSON):
  The full new pane state — same shape as 'pane show <id>' — plus an
  \`updated_fields\` array naming which fields actually changed.`;

export async function runUpdate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, KNOWN_FLAGS, KNOWN_BOOLS, "pane update");

  const paneId = args.positionals[0];
  if (!paneId) fail("missing <pane-id>", "invalid_args");

  const candidate: Record<string, unknown> = {};

  const ttlRaw = args.flags.get("ttl");
  const expiresAtRaw = args.flags.get("expires-at");
  if (ttlRaw !== undefined && expiresAtRaw !== undefined) {
    fail(
      "--ttl and --expires-at are mutually exclusive — pass one or the other",
      "invalid_args",
    );
  }
  if (ttlRaw !== undefined) {
    const ttl = Number(ttlRaw);
    if (!Number.isFinite(ttl)) fail("--ttl must be a number", "invalid_args");
    candidate["ttl"] = ttl;
  }
  if (expiresAtRaw !== undefined) {
    candidate["expires_at"] = expiresAtRaw;
  }

  const titleRaw = args.flags.get("title");
  if (titleRaw !== undefined) candidate["title"] = titleRaw;

  const preambleRaw = args.flags.get("preamble");
  if (preambleRaw !== undefined) candidate["preamble"] = preambleRaw;

  const inputDataRaw = args.flags.get("input-data");
  if (inputDataRaw !== undefined) {
    try {
      candidate["input_data"] = resolveJson(inputDataRaw, "--input-data");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }
  }

  const metaRaw = args.flags.get("metadata");
  if (metaRaw !== undefined) {
    try {
      candidate["metadata"] = resolveJson(metaRaw, "--metadata");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), "invalid_args");
    }
  }

  const tagsRaw = args.flags.get("tags");
  if (tagsRaw !== undefined) {
    const tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    // Empty list explicitly = caller passed `--tags ""`; send [] so the relay
    // wipes per-pane tags down to just the template inheritance.
    candidate["tags"] = tags;
  }

  // Icon overrides. The set-flag and the clear-flag for the same field are
  // contradictory — refuse rather than silently picking one.
  const iconEmojiRaw = args.flags.get("icon-emoji");
  const clearIconEmoji = args.bools.has("clear-icon-emoji");
  if (iconEmojiRaw !== undefined && clearIconEmoji) {
    fail(
      "--icon-emoji and --clear-icon-emoji are mutually exclusive",
      "invalid_args",
    );
  }
  if (iconEmojiRaw !== undefined) candidate["icon_emoji"] = iconEmojiRaw;
  if (clearIconEmoji) candidate["icon_emoji"] = null;

  const iconAttachmentRaw = args.flags.get("icon-attachment-id");
  const clearIconAttachment = args.bools.has("clear-icon-attachment-id");
  if (iconAttachmentRaw !== undefined && clearIconAttachment) {
    fail(
      "--icon-attachment-id and --clear-icon-attachment-id are mutually exclusive",
      "invalid_args",
    );
  }
  if (iconAttachmentRaw !== undefined) {
    candidate["icon_attachment_id"] = iconAttachmentRaw;
  }
  if (clearIconAttachment) candidate["icon_attachment_id"] = null;

  // Bail before the round trip if nothing was supplied — the relay would
  // reject this with `invalid_request` anyway, but a local message names the
  // CLI flags the user knows.
  if (Object.keys(candidate).length === 0) {
    fail(
      "pass at least one field to update (see --help for the full list)",
      "invalid_args",
    );
  }

  const parsed = updatePaneSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue && issue.path.length > 0 ? schemaPathToFlag(issue.path) : "request";
    fail(
      `invalid update request: ${where}: ${issue ? issue.message : "validation failed"}`,
      "invalid_args",
      parsed.error.flatten(),
    );
  }

  const req: UpdatePaneRequest = parsed.data;
  const client = makeClient(args);
  try {
    const res = await client.updatePane(paneId!, req);
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}
