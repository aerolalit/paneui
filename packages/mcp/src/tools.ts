// Tool definitions for the Pane MCP server.
//
// Each tool wraps one or more @paneui/core PaneClient operations. The
// descriptions are written for the LLM consumer — they ARE the docs the model
// reads to decide when and how to call each tool. Keep them concrete and
// action-oriented.
//
// Surface design (full parity with the `pane` CLI):
//   - Hot-path nouns are DISCRETE tools with sharp descriptions: create_pane,
//     get_pane_state, get_events, send_to_pane, update_pane, delete_pane,
//     upgrade_pane, list_panes, and the record tools (list_records, get_record,
//     upsert_record, update_record, delete_record, delete_record_collection).
//   - Multi-verb MANAGEMENT nouns each collapse into ONE tool with a required
//     `action` enum and per-action fields: records_admin (template/per-pane
//     collection admin lives under the discrete record tools + this one for the
//     less-common get/delete-collection/poll), template, template_records,
//     participant, share, attachments, taste, key, trash, feedback, agent.
//   - query → run_query (read-only SQL). skill → get_skill (no API key).
//
// MCP is request/response: there is no streaming. The CLI's `watch` becomes a
// long-poll — get_events (events) or list_records with a cursor (records). Each
// description spells out the poll loop so the model drives it correctly.
//
// Schema validation uses Zod raw shapes (the shape McpServer.registerTool
// expects); the SDK validates arguments before the handler runs. For
// consolidated tools the per-action required fields are documented in the tool
// description and re-checked in the handler (a Zod raw shape can't express a
// discriminated union across a flat field set, so the handler asserts the
// action-specific requirements and returns a tight invalid_args error).

import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { PaneClient } from "@paneui/core";
import { PaneApiError } from "@paneui/core";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  resolveUrl,
  describeActiveConfig,
  clearActiveProfile,
} from "./config.js";
import { fetchSkill } from "./skill.js";

/**
 * A structured MCP tool result (text content + optional error flag). The
 * index signature keeps it structurally assignable to the SDK's
 * CallToolResult (which carries an open `[x: string]: unknown`).
 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Host-supplied capabilities for the handful of tools that aren't pure
 * PaneClient wrappers. The stdio server leaves this undefined and the
 * handlers fall back to the CLI config store + a network skill fetch; the
 * relay's HTTP MCP server injects an `env` so those tools resolve against the
 * relay itself (no CLI config on disk, no self-HTTP loop for the skill).
 *
 * This is the single seam that keeps the TOOLS array transport-agnostic and
 * reusable by BOTH servers — every other tool is already a thin PaneClient
 * call and needs nothing from the host.
 */
export interface ToolEnv {
  /** `agent` action=whoami — describe the active identity (no secrets). */
  describeConfig?: () => Record<string, unknown>;
  /** `agent` action=logout — clear the locally-saved profile. */
  clearProfile?: () => Record<string, unknown>;
  /**
   * `get_skill` — return the MCP-flavoured skill markdown + its version. The
   * relay passes its in-process renderer; the stdio server fetches it over
   * HTTP from the relay's /skills route.
   */
  getSkill?: (versionOnly: boolean) => Promise<{
    markdown?: string;
    version?: string;
  }>;
}

/** One registered tool: name, human/LLM description, Zod input shape, handler. */
export interface ToolDef {
  name: string;
  description: string;
  // Zod raw shape — the object passed to z.object(). The MCP SDK accepts this
  // directly in registerTool({ inputSchema }) and validates arguments with it.
  inputSchema: z.ZodRawShape;
  // MCP tool annotations (ToolAnnotations: title + behavioural hints). Both
  // servers thread this straight into registerTool's config so the hints
  // surface in tools/list output for the stdio AND HTTP transports. Hints are
  // advisory metadata for the client/host (Anthropic's connector directory
  // reads them to classify a tool as read-only vs destructive); they do NOT
  // change server behaviour. The hint reflects the MOST-privileged action a
  // tool can take — a consolidated action-enum tool that CAN delete is marked
  // destructive even though it also has read sub-actions.
  annotations: ToolAnnotations;
  // `env` is optional: when omitted (the stdio server + existing tests) the
  // config/skill-coupled tools use their CLI defaults; the relay's HTTP server
  // injects one so the same handlers run server-side.
  handler: (
    client: PaneClient,
    args: Record<string, unknown>,
    env?: ToolEnv,
  ) => Promise<ToolResult>;
}

/** Wrap a JSON-able value as a single text-content tool result. */
function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/** Plain text result (used by get_skill for raw markdown). */
function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Turn any thrown error into a structured `isError` tool result. PaneApiError
 * carries the relay's `code`, HTTP `status`, and an optional remediation
 * `hint`; surface all of it so the model can self-correct (e.g. fix an event
 * type the schema rejected) instead of getting an opaque failure.
 */
function errorResult(e: unknown): ToolResult {
  if (e instanceof PaneApiError) {
    const payload: Record<string, unknown> = {
      error: e.code,
      status: e.status,
      message: e.message,
    };
    if (e.hint) payload["hint"] = e.hint;
    if (e.details !== undefined) payload["details"] = e.details;
    if (e.retryable !== undefined) payload["retryable"] = e.retryable;
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "internal", message }, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * Structured invalid_args error for the per-action validation inside
 * consolidated tools. Mirrors the relay's envelope so the model self-corrects.
 */
function invalidArgs(message: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "invalid_args", message }, null, 2),
      },
    ],
    isError: true,
  };
}

/** Read a required string arg; returns undefined when absent/empty. */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

// ===========================================================================
// Hot-path discrete tools
// ===========================================================================

const createPaneShape = {
  name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Short human-readable label for the auto-created template (e.g. 'Deploy approval'). REQUIRED when you pass `html` (inline form); omit when reusing an existing template via `template_id` (it inherits the template's name).",
    ),
  html: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The pane's UI as a complete inline HTML document. To send data back to you, the page calls window.pane.emit(eventType, payload) — every emitted eventType MUST be declared in event_schema with 'page' in its emittedBy. Read window.pane.inputData for seed data. Pass EITHER `html` (+`name`) for a one-off, OR `template_id` to reuse a saved template — not both.",
    ),
  template_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Reuse an existing named template (id or slug) instead of inline HTML. The template's pinned version supplies the HTML + event/input/record schemas. Mutually exclusive with `html`/`name`/`event_schema`/`input_schema`. Create templates with the `template` tool.",
    ),
  template_version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "With `template_id`: pin this pane to a specific template version. Defaults to the template head's latest version.",
    ),
  event_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Inline form only. Declares which events the page (and you) may emit and validates each payload. Shape: { events: { '<type>': { emittedBy: ['page'|'agent'...], payload: <JSON Schema> } } }. OMIT for a read-only pane.",
    ),
  input_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Inline form only. Optional JSON Schema validating input_data. Needed if input_data references uploaded attachment ids the page must download.",
    ),
  record_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Inline form only. JSON Schema 2020-12 doc with an `x-pane-collections` extension declaring this pane's mutable record collections (todos, comments…). OMIT for an event-only pane.",
    ),
  input_data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional seed data for this pane instance, readable in the page as window.pane.inputData (e.g. the diff to review, the options to pick from).",
    ),
  title: z
    .string()
    .optional()
    .describe(
      "Optional browser tab title for the human (≤80 chars). Defaults to `name`.",
    ),
  preamble: z
    .string()
    .max(300)
    .optional()
    .describe(
      "Optional one/two-line context shown above the UI — 'who is asking, and why'.",
    ),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional pane lifetime in seconds. The relay clamps to its max; the returned expires_at is authoritative.",
    ),
  participants: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional number of distinct human participant URLs to mint (default 1). Each gets its own URL in the returned `urls` array.",
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional opaque JSON you can attach to the pane for your own bookkeeping (never shown to the human, queryable via run_query).",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Optional per-pane filter tags (merged with the template's tags). ≤20 tags, ≤50 chars each; 'favorite'/'favorites' are reserved.",
    ),
  icon_emoji: z
    .string()
    .optional()
    .describe("Optional single-emoji icon override for this pane."),
  icon_attachment_id: z
    .string()
    .optional()
    .describe(
      "Optional per-pane icon as a ready raster-image attachment id (png/jpeg/webp/gif). Upload it first via the `attachments` tool (scope: pane or agent).",
    ),
  callback: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional webhook callback config so the relay POSTs new events to your endpoint. Shape per the relay's callback schema (e.g. { url, secret? }). Most MCP agents poll with get_events instead.",
    ),
  context_key: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Optional natural key (e.g. 'pr-42'). Repeated create_pane calls with the same (template, key) return the SAME pane — makes retries idempotent.",
    ),
};

const getPaneStateShape = {
  pane_id: z.string().min(1).describe("The pane id returned by create_pane."),
};

const getEventsShape = {
  pane_id: z.string().min(1).describe("The pane id to read events from."),
  since: z
    .string()
    .optional()
    .describe(
      "Opaque cursor from a previous get_events call's next_cursor. Omit on the first call to read from the beginning.",
    ),
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(30)
    .optional()
    .describe(
      "Optional long-poll: how long the relay holds the request open waiting for a new event (0–30s). Use ~25 when waiting for a human to act, then call again with the same cursor.",
    ),
};

const sendToPaneShape = {
  pane_id: z.string().min(1).describe("The pane id to push the event into."),
  type: z
    .string()
    .min(1)
    .describe(
      "Event type. Must be declared in the pane's event_schema with 'agent' in its emittedBy list.",
    ),
  data: z
    .unknown()
    .describe(
      "Event payload — any JSON value valid against the type's payload schema. Use {} or null for a no-payload event.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Optional dedup key — a repeat send with the same key is a no-op.",
    ),
};

const updatePaneShape = {
  pane_id: z.string().min(1).describe("The pane id to edit."),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Reset the pane's lifetime to now + this many seconds. Mutually exclusive with expires_at.",
    ),
  expires_at: z
    .string()
    .optional()
    .describe(
      "Set expires_at to a specific future ISO-8601 timestamp. Mutually exclusive with ttl_seconds.",
    ),
  title: z.string().optional().describe("New tab title."),
  preamble: z
    .string()
    .optional()
    .describe("New preamble (context band above the UI)."),
  input_data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Replace the pane's input_data wholesale (revalidated against the pinned template version's input_schema).",
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Replace the pane's metadata wholesale."),
  tags: z.array(z.string()).optional().describe("Replace the per-pane tags."),
  icon_emoji: z.string().optional().describe("Set the per-pane emoji icon."),
  icon_attachment_id: z
    .string()
    .optional()
    .describe("Set the per-pane icon to a ready raster-image attachment id."),
  clear_icon_emoji: z
    .boolean()
    .optional()
    .describe("Clear the emoji override (fall back to the template's icon)."),
  clear_icon_attachment_id: z
    .boolean()
    .optional()
    .describe(
      "Clear the attachment icon override (fall back to the template's icon).",
    ),
};

const upgradePaneShape = {
  pane_id: z.string().min(1).describe("The pane id to re-pin."),
  template_version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Target version of the SAME template. Defaults to the template head's latest version.",
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "Override the strict schema-compat gate (compat=force). Without it, an upgrade that would narrow the schema is refused with schema_incompatible_upgrade + details.breaks.",
    ),
};

const listPanesShape = {
  status: z
    .enum(["open", "closed", "all"])
    .optional()
    .describe("Filter by effective status. Default: open."),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Page size (default 50, max 200)."),
  cursor: z
    .string()
    .optional()
    .describe("Opaque cursor from a previous page's next_cursor."),
  template_id: z
    .string()
    .optional()
    .describe(
      "Filter to panes instantiated from a specific named template (head id, not version id).",
    ),
};

const deletePaneShape = {
  pane_id: z
    .string()
    .min(1)
    .describe("The pane id to close/delete (idempotent)."),
};

// ----- record CRUD (hot-path, kept discrete + back-compatible) -------------

const listRecordsShape = {
  pane_id: z.string().min(1).describe("The pane id."),
  collection: z
    .string()
    .min(1)
    .describe(
      "The record collection name declared in the pane's record schema.",
    ),
  since: z
    .number()
    .int()
    .optional()
    .describe(
      "Optional cursor (next_since from a prior call). Also the POLL handle: to watch a collection (no streaming in MCP), call repeatedly passing the previous next_since to fetch only newer/changed rows.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Optional page size (max 200)."),
  include_tombstones: z
    .boolean()
    .optional()
    .describe(
      "Include soft-deleted rows (deleted_at set) so you can observe deletions. Default false.",
    ),
};

const getRecordShape = {
  pane_id: z.string().min(1).describe("The pane id."),
  collection: z.string().min(1).describe("The record collection name."),
  record_key: z.string().min(1).describe("The key of the record to fetch."),
};

const upsertRecordShape = {
  pane_id: z.string().min(1).describe("The pane id."),
  collection: z.string().min(1).describe("The record collection name."),
  record_key: z
    .string()
    .optional()
    .describe(
      "Optional stable key. Reusing an existing key returns the existing row (deduped:true).",
    ),
  data: z
    .unknown()
    .describe(
      "The record body — any JSON value valid against the collection schema.",
    ),
};

const updateRecordShape = {
  pane_id: z.string().min(1).describe("The pane id."),
  collection: z.string().min(1).describe("The record collection name."),
  record_key: z.string().min(1).describe("The key of the record to update."),
  data: z.unknown().describe("The new record body (replaces the row's data)."),
  if_match: z
    .number()
    .int()
    .optional()
    .describe(
      "Optional optimistic-lock version. On mismatch the update is rejected with the current row in details.current.",
    ),
};

const deleteRecordShape = {
  pane_id: z.string().min(1).describe("The pane id."),
  collection: z.string().min(1).describe("The record collection name."),
  record_key: z.string().min(1).describe("The key of the record to delete."),
  if_match: z
    .number()
    .int()
    .optional()
    .describe("Optional optimistic-lock version."),
};

const deleteRecordCollectionShape = {
  pane_id: z.string().min(1).describe("The pane id."),
  collection: z
    .string()
    .min(1)
    .describe("The record collection to drop in its entirety."),
  confirm: z
    .literal(true)
    .describe(
      "Required (true) to drop the whole collection. This removes every row plus the collection row itself and cannot be undone.",
    ),
};

// ===========================================================================
// Consolidated management tools
// ===========================================================================

const templateShape = {
  action: z
    .enum([
      "create",
      "version",
      "update",
      "search",
      "list",
      "show",
      "get_version",
      "delete",
      "publish",
      "unpublish",
      "search_public",
      "set_icon",
    ])
    .describe(
      "Which template operation to run. create: a new named template (needs name+html). version: append a new immutable version to an existing template (id+html). update: patch head metadata (name/slug/description/tags). search/list: find the agent's templates (search takes an optional query). show: full template + version list (id). get_version: one version's content (id+version). delete: remove the template + all versions (id, requires confirm:true). publish/unpublish: public catalog (id). search_public: the public catalog across all agents (optional query). set_icon: set/clear a template's icon (id + one of emoji / icon_attachment_id / clear).",
    ),
  id: z
    .string()
    .optional()
    .describe(
      "Template id or slug. Required for version/update/show/get_version/delete/publish/unpublish/set_icon.",
    ),
  query: z
    .string()
    .optional()
    .describe("Free-text search (for search / search_public)."),
  name: z
    .string()
    .optional()
    .describe("Template display name (required for create)."),
  slug: z
    .string()
    .optional()
    .describe("Stable agent-chosen handle (create/update)."),
  description: z
    .string()
    .optional()
    .describe("Prose description (create/update)."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Search keywords (create/update)."),
  html: z
    .string()
    .optional()
    .describe("HTML template body / source (required for create + version)."),
  template_type: z
    .enum(["html-inline", "html-ref"])
    .optional()
    .describe(
      "Source kind. Default html-inline; html-ref treats html as a URL.",
    ),
  event_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Event schema (create/version). Omit for a view-only template."),
  input_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Per-pane input_data JSON Schema (create/version)."),
  record_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Per-pane record collections schema (create/version)."),
  template_record_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Template-level (shared) record collections schema (create/version). Set this before using the template_records tool.",
    ),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Version number (required for get_version)."),
  scopes: z
    .array(z.string())
    .optional()
    .describe(
      "verb:noun permission scopes for publish (e.g. ['read:agent']). Empty array clears them.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("search_public page size (1..50)."),
  offset: z.number().int().min(0).optional().describe("search_public offset."),
  icon_emoji: z.string().optional().describe("set_icon: a single-emoji icon."),
  icon_attachment_id: z
    .string()
    .optional()
    .describe("set_icon: a ready template-scoped raster-image attachment id."),
  clear: z
    .boolean()
    .optional()
    .describe("set_icon: clear both the emoji and image icon."),
  confirm: z
    .boolean()
    .optional()
    .describe("Required (true) for the destructive `delete` action."),
};

const templateRecordsShape = {
  action: z
    .enum(["list", "get", "upsert", "update", "delete", "delete_collection"])
    .describe(
      "Operation on a TEMPLATE-level (owner-curated, shared across every pane of the template) record collection. Same grammar as the per-pane record tools but scoped to a template head. The template version must declare the collection via template_record_schema (set it with the `template` tool).",
    ),
  template_id: z.string().min(1).describe("Template id or slug."),
  collection: z.string().min(1).describe("The template-level collection name."),
  record_key: z
    .string()
    .optional()
    .describe(
      "Record key. Required for get/update/delete; optional for upsert.",
    ),
  data: z
    .unknown()
    .optional()
    .describe("Record body. Required for upsert/update."),
  if_match: z
    .number()
    .int()
    .optional()
    .describe("Optimistic-lock version for update/delete."),
  since: z.number().int().optional().describe("List cursor (and poll handle)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("List page size."),
  include_tombstones: z
    .boolean()
    .optional()
    .describe("Include soft-deleted rows in list."),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Required (true) for delete_collection (drops the whole collection).",
    ),
};

const participantShape = {
  action: z
    .enum(["list", "new", "revoke"])
    .describe(
      "Manage a pane's participant URLs. list: every participant (active + revoked) — use it to find a participant_id. new: mint a FRESH human URL on an existing pane (the plaintext token is returned ONCE — save it before delivering). revoke: invalidate one participant URL.",
    ),
  pane_id: z.string().min(1).describe("The pane id."),
  participant_id: z
    .string()
    .optional()
    .describe("The participant id to revoke (required for revoke)."),
};

const shareShape = {
  action: z
    .enum(["list", "invite", "set_access", "revoke"])
    .describe(
      "Identity sharing on a pane. list: access_mode + all grants. invite: invite a human by email (role participant|viewer). set_access: set the /p access mode (invite_only|link|public). revoke: remove one grant by id. Token (/s/<token>) links are independent of access_mode.",
    ),
  pane_id: z.string().min(1).describe("The pane id."),
  email: z.string().optional().describe("Invitee email (required for invite)."),
  role: z
    .enum(["participant", "viewer"])
    .optional()
    .describe("Grant role for invite (default participant)."),
  access_mode: z
    .enum(["invite_only", "link", "public"])
    .optional()
    .describe("Access mode for set_access."),
  grant_id: z
    .string()
    .optional()
    .describe("Grant id to revoke (required for revoke)."),
};

const attachmentsShape = {
  action: z
    .enum([
      "upload",
      "download",
      "show",
      "list",
      "delete",
      "mint_token",
      "revoke_token",
      "list_tokens",
    ])
    .describe(
      "Binary attachment operations. upload: read a local file (file_path) and upload it; scope agent|pane|template. download: fetch bytes by attachment_id to out_path (absolute) or return base64. show: metadata only. list: the agent's attachments. delete: soft-delete. mint_token: mint a /b/<token> capability URL (returned ONCE). revoke_token / list_tokens: manage those tokens.",
    ),
  attachment_id: z
    .string()
    .optional()
    .describe(
      "Attachment id. Required for download/show/delete/mint_token/revoke_token/list_tokens.",
    ),
  file_path: z
    .string()
    .optional()
    .describe("upload: ABSOLUTE path to the local file to upload."),
  scope: z
    .enum(["agent", "pane", "template"])
    .optional()
    .describe("upload scope (default agent)."),
  pane_id: z.string().optional().describe("Required when scope=pane."),
  template_id: z.string().optional().describe("Required when scope=template."),
  filename: z
    .string()
    .optional()
    .describe("upload: display filename (defaults to the file's basename)."),
  mime: z
    .string()
    .optional()
    .describe(
      "upload: advisory Content-Type (the relay sniffs the bytes regardless).",
    ),
  out_path: z
    .string()
    .optional()
    .describe(
      "download: ABSOLUTE path to write the bytes to. If omitted, the bytes are returned base64-encoded in the result.",
    ),
  cursor: z.string().optional().describe("list pagination cursor."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("list page size (1..100)."),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("mint_token: per-token TTL (clamped by scope default)."),
  once: z
    .boolean()
    .optional()
    .describe("mint_token: token self-deletes on first GET."),
  token_id: z
    .string()
    .optional()
    .describe("revoke_token: the token id to revoke."),
};

const tasteShape = {
  action: z
    .enum(["get", "set", "clear"])
    .describe(
      "The agent's freeform UI taste notes (markdown) — presentation preferences learned from human feedback. get: read them before generating a pane. set: whole-document replace (taste, non-empty). clear: delete them.",
    ),
  taste: z
    .string()
    .optional()
    .describe(
      "The full markdown notes (required for set; whole-document replace, not append).",
    ),
};

const keyShape = {
  action: z
    .enum(["list", "revoke"])
    .describe(
      "The calling agent's API key. list: key info (agent_id, key_prefix, timestamps). revoke: self-destruct the agent's OWN key — it stops working immediately and is irreversible (requires confirm:true).",
    ),
  confirm: z.boolean().optional().describe("Required (true) for revoke."),
};

const trashShape = {
  action: z
    .enum(["list", "restore", "restore_template", "purge", "purge_template"])
    .describe(
      "Soft-delete trash. list: trashed panes + templates. restore/purge: un-trash or hard-delete a pane (id). restore_template/purge_template: same for a template (id|slug). purge bypasses the retention window (permanent).",
    ),
  id: z
    .string()
    .optional()
    .describe(
      "Pane id (restore/purge) or template id|slug (restore_template/purge_template).",
    ),
};

const feedbackShape = {
  action: z
    .enum(["create", "list"])
    .describe(
      "Feedback to the relay operator. create: submit a bug|feature|note with a message (optional pane_id). list: the agent's own submissions, newest first.",
    ),
  type: z
    .enum(["bug", "feature", "note"])
    .optional()
    .describe("Feedback category (required for create)."),
  message: z
    .string()
    .optional()
    .describe("Message body (required for create)."),
  pane_id: z
    .string()
    .optional()
    .describe("Optional pane this feedback relates to (create)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("list page size (default 50, max 100)."),
  before: z
    .string()
    .optional()
    .describe("list cursor from a prior page's next_before."),
};

const agentShape = {
  action: z
    .enum(["whoami", "claim", "logout"])
    .describe(
      "Agent identity. whoami: show the resolved relay URL, active profile, and whether a key is configured (no network, no secrets). claim: bind this agent to a human via a one-shot claim code the human generated in their Settings UI (one-way). logout: clear the locally-saved key/profile (does NOT revoke it on the relay — use the key tool's revoke for that).",
    ),
  code: z
    .string()
    .optional()
    .describe("The one-shot claim code (required for claim)."),
};

const runQueryShape = {
  sql: z
    .string()
    .min(1)
    .describe(
      "Read-only SQL (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN/PRAGMA) over your scoped data. Tables: panes(id,title,template_id,template_version,status,created_at,expires_at,deleted_at,metadata,input_data), records(id,pane_id,collection,key,data,version,seq,author_kind,author_id,created_at,updated_at,deleted_at), events(id,pane_id,type,ts,author_kind,author_id,data,template_version_id). `data` is JSON — project with ->> / ->. Capped at 10k rows; 10s timeout.",
    ),
  pane_id: z
    .string()
    .optional()
    .describe(
      "Scope the query to a single pane (resolves a view_conflict when two of your panes share a collection name with different schemas).",
    ),
  format: z
    .enum(["json", "csv", "tsv", "table"])
    .optional()
    .describe(
      "Output format. Default json (columns+rows+meta). csv/tsv/table render the rows as text.",
    ),
};

const getSkillShape = {
  version_only: z
    .boolean()
    .optional()
    .describe(
      "If true, return only the relay's current skill version string instead of the full SKILL.md markdown.",
    ),
};

// ===========================================================================
// Tool definitions
// ===========================================================================

export const TOOLS: ToolDef[] = [
  {
    name: "create_pane",
    description:
      "Hand the human a rich interactive UI by URL and (optionally) get structured data back. Build the UI as inline HTML (pass `name` + `html`) OR reuse a saved template (pass `template_id`). The relay hosts it and returns a URL. ALWAYS give the returned url to the human — paste it into the conversation and ask them to open it. Reach for this whenever a text reply is the wrong shape: forms, approvals, pickers, surveys, dashboards, diff/doc review, wizards. If the page captures input it emits events back to you (poll them with get_events) or mutates record collections (the record tools). BEFORE authoring: call get_skill for the events-vs-records decision + schema grammar, and the `taste` tool (action: get) for the human's house style — both shape the HTML you write. Returns { pane_id, url, urls, title, expires_at }.",
    inputSchema: createPaneShape,
    annotations: {
      title: "Create Pane",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (client, args) => {
      try {
        const hasTemplateId = str(args, "template_id") !== undefined;
        const hasHtml = str(args, "html") !== undefined;
        if (hasTemplateId === hasHtml) {
          return invalidArgs(
            "pass exactly one of `html` (inline form, with `name`) or `template_id` (reuse a saved template)",
          );
        }

        let template: Record<string, unknown>;
        if (hasTemplateId) {
          template = { id: args["template_id"] };
          if (args["template_version"] !== undefined)
            template["version"] = args["template_version"];
        } else {
          if (str(args, "name") === undefined) {
            return invalidArgs("`name` is required with `html` (inline form)");
          }
          template = {
            name: args["name"],
            type: "html-inline",
            source: args["html"],
          };
          if (args["event_schema"] !== undefined)
            template["event_schema"] = args["event_schema"];
          if (args["input_schema"] !== undefined)
            template["input_schema"] = args["input_schema"];
          if (args["record_schema"] !== undefined)
            template["record_schema"] = args["record_schema"];
        }

        const req: Record<string, unknown> = { template };
        if (args["input_data"] !== undefined)
          req["input_data"] = args["input_data"];
        if (args["title"] !== undefined) req["title"] = args["title"];
        if (args["preamble"] !== undefined) req["preamble"] = args["preamble"];
        if (args["ttl_seconds"] !== undefined) req["ttl"] = args["ttl_seconds"];
        if (args["participants"] !== undefined)
          req["participants"] = { humans: args["participants"] };
        if (args["metadata"] !== undefined) req["metadata"] = args["metadata"];
        if (args["tags"] !== undefined) req["tags"] = args["tags"];
        if (args["icon_emoji"] !== undefined)
          req["icon_emoji"] = args["icon_emoji"];
        if (args["icon_attachment_id"] !== undefined)
          req["icon_attachment_id"] = args["icon_attachment_id"];
        if (args["callback"] !== undefined) req["callback"] = args["callback"];
        if (args["context_key"] !== undefined)
          req["context_key"] = args["context_key"];

        const res = await client.createPane(
          req as Parameters<PaneClient["createPane"]>[0],
        );
        const humanUrl = res.urls.humans[0] ?? null;
        return jsonResult({
          pane_id: res.pane_id,
          url: humanUrl,
          urls: res.urls.humans,
          title: res.title,
          expires_at: res.expires_at,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "get_pane_state",
    description:
      "Fetch a pane's current metadata (status, title, template version, timestamps, expires_at) WITHOUT its event log. Use it to check whether a pane is still open or has expired. To read what the human did, use get_events.",
    inputSchema: getPaneStateShape,
    annotations: {
      title: "Get Pane State",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        return jsonResult(await client.getPane(String(args["pane_id"])));
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "get_events",
    description:
      "Poll a pane's append-only event log for what the human did (form submissions, approvals, picks). This is how you receive the round-trip result — there is no push/streaming in MCP. Poll loop: call with no `since` first; process the returned events; remember next_cursor; call again passing it as `since` to get only newer events. To WAIT for a human who hasn't acted yet, pass wait_seconds (~25) so the relay holds the request open until an event arrives or it times out, then call again with the same cursor. Returns { events, next_cursor }.",
    inputSchema: getEventsShape,
    annotations: {
      title: "Get Events",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const page = await client.getEvents(String(args["pane_id"]), {
          since: args["since"] as string | undefined,
          waitSeconds: args["wait_seconds"] as number | undefined,
        });
        return jsonResult(page);
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "send_to_pane",
    description:
      "Push an event INTO an open pane — update the live UI the human is looking at (progress, a new message, a status change, fresh data). The event type must be declared in the pane's event_schema with 'agent' in its emittedBy. For mutable collections (todos, line items, comment threads) prefer the record tools instead. Returns { event, deduped }.",
    inputSchema: sendToPaneShape,
    annotations: {
      title: "Send to Pane",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (client, args) => {
      try {
        const res = await client.sendEvent(String(args["pane_id"]), {
          type: String(args["type"]),
          data: args["data"],
          idempotencyKey: args["idempotency_key"] as string | undefined,
        });
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "update_pane",
    description:
      "Edit instance-level fields on a LIVE pane in place (PATCH) without minting a new one — the pane keeps its id, URL, event log, and template pin. Settable: ttl_seconds OR expires_at (mutually exclusive), title, preamble, input_data (replaced wholesale + revalidated), metadata, tags, icon_emoji / icon_attachment_id (or clear_* to drop the override). Pass at least one field. Returns the full new pane state + an updated_fields array. To swap the HTML/schemas, use upgrade_pane instead.",
    inputSchema: updatePaneShape,
    annotations: {
      title: "Update Pane",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const body: Record<string, unknown> = {};
        if (
          args["ttl_seconds"] !== undefined &&
          args["expires_at"] !== undefined
        ) {
          return invalidArgs(
            "ttl_seconds and expires_at are mutually exclusive",
          );
        }
        if (args["ttl_seconds"] !== undefined)
          body["ttl"] = args["ttl_seconds"];
        if (args["expires_at"] !== undefined)
          body["expires_at"] = args["expires_at"];
        if (args["title"] !== undefined) body["title"] = args["title"];
        if (args["preamble"] !== undefined) body["preamble"] = args["preamble"];
        if (args["input_data"] !== undefined)
          body["input_data"] = args["input_data"];
        if (args["metadata"] !== undefined) body["metadata"] = args["metadata"];
        if (args["tags"] !== undefined) body["tags"] = args["tags"];
        if (args["icon_emoji"] !== undefined && args["clear_icon_emoji"]) {
          return invalidArgs(
            "icon_emoji and clear_icon_emoji are mutually exclusive",
          );
        }
        if (args["icon_emoji"] !== undefined)
          body["icon_emoji"] = args["icon_emoji"];
        if (args["clear_icon_emoji"]) body["icon_emoji"] = null;
        if (
          args["icon_attachment_id"] !== undefined &&
          args["clear_icon_attachment_id"]
        ) {
          return invalidArgs(
            "icon_attachment_id and clear_icon_attachment_id are mutually exclusive",
          );
        }
        if (args["icon_attachment_id"] !== undefined)
          body["icon_attachment_id"] = args["icon_attachment_id"];
        if (args["clear_icon_attachment_id"]) body["icon_attachment_id"] = null;

        if (Object.keys(body).length === 0) {
          return invalidArgs("pass at least one field to update");
        }
        const res = await client.updatePane(
          String(args["pane_id"]),
          body as Parameters<PaneClient["updatePane"]>[1],
        );
        return jsonResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "upgrade_pane",
    description:
      "Re-pin a LIVE pane to another version of its SAME template (POST /upgrade) — swap the HTML (design) and event/input/record schemas in place. The human keeps the same URL; no new pane is created. Use after appending a new template version with the `template` tool (action: version). By default a strict schema-compat gate refuses an upgrade that would narrow the schema (returns schema_incompatible_upgrade + details.breaks); pass force:true to apply anyway. Returns { pane_id, template_version, upgraded, breaks, compat }.",
    inputSchema: upgradePaneShape,
    annotations: {
      title: "Upgrade Pane",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const opts: { template_version?: number; compat?: "strict" | "force" } =
          {};
        if (args["template_version"] !== undefined)
          opts.template_version = args["template_version"] as number;
        if (args["force"]) opts.compat = "force";
        return jsonResult(
          await client.upgradePane(String(args["pane_id"]), opts),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "list_panes",
    description:
      "Enumerate YOUR agent's panes (newest first). Use it to find a pane_id you lost, audit what's open, or get a cursor for pagination. No secrets in the response (participant tokens are unrecoverable — mint a fresh URL with the participant tool). Filter by status (open|closed|all) or template_id. Returns { items, next_cursor }.",
    inputSchema: listPanesShape,
    annotations: {
      title: "List Panes",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const opts: Record<string, unknown> = {};
        if (args["status"] !== undefined) opts["status"] = args["status"];
        if (args["limit"] !== undefined) opts["limit"] = args["limit"];
        if (args["cursor"] !== undefined) opts["cursor"] = args["cursor"];
        if (args["template_id"] !== undefined)
          opts["template_id"] = args["template_id"];
        return jsonResult(
          await client.listPanes(
            opts as Parameters<PaneClient["listPanes"]>[0],
          ),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "delete_pane",
    description:
      "Close/delete a pane (idempotent — an already-closed pane still succeeds). The human's URL stops working. To merely edit a pane keep it alive with update_pane; to recover a soft-deleted pane use the trash tool (action: restore).",
    inputSchema: deletePaneShape,
    annotations: {
      title: "Delete Pane",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        await client.deletePane(String(args["pane_id"]));
        return jsonResult({ pane_id: args["pane_id"], deleted: true });
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  // ----- record CRUD (discrete, hot-path) -----------------------------------
  {
    name: "list_records",
    description:
      "List rows in a pane's mutable record collection (todo list, shopping list, kanban board, comment thread). Records are the right primitive when the page shows several mutable items and the CURRENT state matters more than the history. This also doubles as the POLL/watch for records (no streaming in MCP): pass the prior next_since to fetch only newer/changed rows. include_tombstones:true surfaces deletions. Returns { records, next_since, has_more }.",
    inputSchema: listRecordsShape,
    annotations: {
      title: "List Records",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const out = await client.listRecords(
          String(args["pane_id"]),
          String(args["collection"]),
          {
            since: args["since"] as number | undefined,
            limit: args["limit"] as number | undefined,
          },
        );
        const records = args["include_tombstones"]
          ? out.records
          : out.records.filter((r) => r.deleted_at === null);
        return jsonResult({
          records,
          next_since: out.next_since,
          has_more: out.has_more,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "get_record",
    description:
      "Fetch a single record row by its key from a pane collection (scans the collection — fine for a one-off lookup, not a hot loop). Returns { record } or an isError record_not_found.",
    inputSchema: getRecordShape,
    annotations: {
      title: "Get Record",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const row = await client.getRecord(
          String(args["pane_id"]),
          String(args["collection"]),
          String(args["record_key"]),
        );
        if (!row) {
          return invalidArgs(
            `no record at key '${args["record_key"]}' in collection '${args["collection"]}'`,
          );
        }
        return jsonResult({ record: row });
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "upsert_record",
    description:
      "Create a row in a pane's record collection, or return the existing row if record_key is already present (deduped:true). Use to add a todo, a line item, a comment, etc. The collection must be declared in the pane's record schema with 'agent' allowed to write. If you're still designing the pane, call get_skill first for the records-vs-events decision and the x-pane-collections schema grammar. Returns { record, deduped }.",
    inputSchema: upsertRecordShape,
    annotations: {
      title: "Upsert Record",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const body: { record_key?: string; data: unknown } = {
          data: args["data"],
        };
        if (args["record_key"] !== undefined)
          body.record_key = String(args["record_key"]);
        return jsonResult(
          await client.upsertRecord(
            String(args["pane_id"]),
            String(args["collection"]),
            body,
          ),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "update_record",
    description:
      "Update an existing row in a pane's record collection (replaces its data). Pass if_match with the row's current version for an optimistic-locked update — on a version mismatch the relay returns the current row so you can retry. Returns { record }.",
    inputSchema: updateRecordShape,
    annotations: {
      title: "Update Record",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const body: { data: unknown; if_match?: number } = {
          data: args["data"],
        };
        if (args["if_match"] !== undefined)
          body.if_match = args["if_match"] as number;
        return jsonResult(
          await client.updateRecord(
            String(args["pane_id"]),
            String(args["collection"]),
            String(args["record_key"]),
            body,
          ),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "delete_record",
    description:
      "Soft-delete a row from a pane's record collection. The page sees the deletion live (the row becomes a tombstone in list_records). Pass if_match for an optimistic-locked delete. Returns { deleted: true }.",
    inputSchema: deleteRecordShape,
    annotations: {
      title: "Delete Record",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        await client.deleteRecord(
          String(args["pane_id"]),
          String(args["collection"]),
          String(args["record_key"]),
          args["if_match"] !== undefined
            ? { ifMatch: args["if_match"] as number }
            : {},
        );
        return jsonResult({ deleted: true, key: args["record_key"] });
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "delete_record_collection",
    description:
      "Drop a WHOLE per-pane record collection at once: every row plus the collection row itself. Use this to reset or remove a collection (todo list, comment thread, board) rather than deleting rows one by one with delete_record. Owner-only and destructive, so it requires confirm:true. Collection names are immutable, so to rename a collection drop the old one and write under the new name. Returns { deleted: true, collection }.",
    inputSchema: deleteRecordCollectionShape,
    annotations: {
      title: "Delete Record Collection",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        if (args["confirm"] !== true) {
          return invalidArgs(
            "delete_record_collection drops the whole collection. Pass confirm:true to proceed.",
          );
        }
        await client.deleteRecordCollection(
          String(args["pane_id"]),
          String(args["collection"]),
        );
        return jsonResult({ deleted: true, collection: args["collection"] });
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  // ----- consolidated management tools --------------------------------------
  {
    name: "template",
    description:
      "Manage reusable, versioned UI templates (author once, instance many times via create_pane's template_id). ONE tool with an `action` enum: create | version | update | search | list | show | get_version | delete | publish | unpublish | search_public | set_icon. Required fields per action are documented on the `action` parameter. A template is HTML + an event schema (+ optional input/record/template-record schemas); a pane is one use of one version of it.",
    inputSchema: templateShape,
    // Consolidated action-enum tool: read sub-actions (search/list/show/
    // get_version/search_public) coexist with mutating ones (create/version/
    // update/delete/publish/...). The hint reflects the most-privileged action
    // (delete is destructive), so readOnlyHint:false + destructiveHint:true.
    annotations: {
      title: "Manage Templates",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "create": {
            if (
              str(args, "name") === undefined ||
              str(args, "html") === undefined
            ) {
              return invalidArgs("create requires `name` and `html`");
            }
            const req: Record<string, unknown> = {
              name: args["name"],
              type: (args["template_type"] as string) ?? "html-inline",
              source: args["html"],
            };
            for (const k of [
              "slug",
              "description",
              "tags",
              "event_schema",
              "input_schema",
              "record_schema",
              "template_record_schema",
              "icon_emoji",
            ]) {
              if (args[k] !== undefined) req[k] = args[k];
            }
            const res = await client.createArtifact(
              req as unknown as Parameters<PaneClient["createArtifact"]>[0],
            );
            return jsonResult({
              template_id: res.template_id,
              slug: str(args, "slug") ?? null,
              version: res.version,
            });
          }
          case "version": {
            if (
              str(args, "id") === undefined ||
              str(args, "html") === undefined
            ) {
              return invalidArgs("version requires `id` and `html`");
            }
            const req: Record<string, unknown> = {
              type: (args["template_type"] as string) ?? "html-inline",
              source: args["html"],
            };
            for (const k of [
              "event_schema",
              "input_schema",
              "record_schema",
              "template_record_schema",
            ]) {
              if (args[k] !== undefined) req[k] = args[k];
            }
            return jsonResult(
              await client.createArtifactVersion(
                String(args["id"]),
                req as unknown as Parameters<
                  PaneClient["createArtifactVersion"]
                >[1],
              ),
            );
          }
          case "update": {
            if (str(args, "id") === undefined)
              return invalidArgs("update requires `id`");
            const meta: Record<string, unknown> = {};
            for (const k of ["name", "slug", "description", "tags"]) {
              if (args[k] !== undefined) meta[k] = args[k];
            }
            if (Object.keys(meta).length === 0) {
              return invalidArgs(
                "update needs at least one of name/slug/description/tags",
              );
            }
            return jsonResult(
              await client.updateArtifact(
                String(args["id"]),
                meta as Parameters<PaneClient["updateArtifact"]>[1],
              ),
            );
          }
          case "search":
            return jsonResult(await client.searchArtifacts(str(args, "query")));
          case "list":
            return jsonResult(await client.searchArtifacts());
          case "show":
            if (str(args, "id") === undefined)
              return invalidArgs("show requires `id`");
            return jsonResult(await client.getArtifact(String(args["id"])));
          case "get_version": {
            if (
              str(args, "id") === undefined ||
              args["version"] === undefined
            ) {
              return invalidArgs("get_version requires `id` and `version`");
            }
            return jsonResult(
              await client.getArtifactVersion(
                String(args["id"]),
                args["version"] as number,
              ),
            );
          }
          case "delete": {
            if (str(args, "id") === undefined)
              return invalidArgs("delete requires `id`");
            if (args["confirm"] !== true) {
              return invalidArgs(
                "delete is destructive (removes the template + all versions) — pass confirm:true",
              );
            }
            await client.deleteArtifact(String(args["id"]));
            return jsonResult({ template: args["id"], deleted: true });
          }
          case "publish": {
            if (str(args, "id") === undefined)
              return invalidArgs("publish requires `id`");
            const body: { scopes?: string[] } = {};
            if (args["scopes"] !== undefined)
              body.scopes = args["scopes"] as string[];
            return jsonResult(
              await client.publishTemplate(String(args["id"]), body),
            );
          }
          case "unpublish":
            if (str(args, "id") === undefined)
              return invalidArgs("unpublish requires `id`");
            return jsonResult(
              await client.unpublishTemplate(String(args["id"])),
            );
          case "search_public": {
            const opts: { limit?: number; offset?: number } = {};
            if (args["limit"] !== undefined)
              opts.limit = args["limit"] as number;
            if (args["offset"] !== undefined)
              opts.offset = args["offset"] as number;
            return jsonResult(
              await client.searchPublicTemplates(str(args, "query"), opts),
            );
          }
          case "set_icon": {
            if (str(args, "id") === undefined)
              return invalidArgs("set_icon requires `id`");
            const id = String(args["id"]);
            const hasEmoji = str(args, "icon_emoji") !== undefined;
            const hasAttachment = str(args, "icon_attachment_id") !== undefined;
            const clear = args["clear"] === true;
            const chosen = [hasEmoji, hasAttachment, clear].filter(
              Boolean,
            ).length;
            if (chosen !== 1) {
              return invalidArgs(
                "set_icon needs exactly one of icon_emoji, icon_attachment_id, or clear:true",
              );
            }
            const meta: Record<string, unknown> = clear
              ? { icon_emoji: null, icon_attachment_id: null }
              : hasEmoji
                ? { icon_emoji: args["icon_emoji"] }
                : { icon_attachment_id: args["icon_attachment_id"] };
            return jsonResult(
              await client.updateArtifact(
                id,
                meta as Parameters<PaneClient["updateArtifact"]>[1],
              ),
            );
          }
          default:
            return invalidArgs(`unknown template action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "template_records",
    description:
      "CRUD for TEMPLATE-level record collections — owner-curated content anchored to a template head and visible to every pane derived from any of its versions (vs per-pane records, which are the discrete record tools). ONE tool with an `action` enum: list | get | upsert | update | delete | delete_collection. The template version must declare the collection via template_record_schema (set it with the `template` tool first).",
    inputSchema: templateRecordsShape,
    // Consolidated tool: read actions (list/get) + mutating ones (upsert/
    // update/delete/delete_collection). Hint reflects the destructive action.
    annotations: {
      title: "Manage Template Records",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      const templateId = String(args["template_id"]);
      const collection = String(args["collection"]);
      try {
        switch (action) {
          case "list": {
            const out = await client.listTemplateRecords(
              templateId,
              collection,
              {
                since: args["since"] as number | undefined,
                limit: args["limit"] as number | undefined,
              },
            );
            const records = args["include_tombstones"]
              ? out.records
              : out.records.filter((r) => r.deleted_at === null);
            return jsonResult({
              records,
              next_since: out.next_since,
              has_more: out.has_more,
            });
          }
          case "get": {
            if (str(args, "record_key") === undefined)
              return invalidArgs("get requires `record_key`");
            const row = await client.getTemplateRecord(
              templateId,
              collection,
              String(args["record_key"]),
            );
            if (!row) {
              return invalidArgs(
                `no template record at key '${args["record_key"]}' in '${collection}'`,
              );
            }
            return jsonResult({ record: row });
          }
          case "upsert": {
            if (args["data"] === undefined)
              return invalidArgs("upsert requires `data`");
            const body: { record_key?: string; data: unknown } = {
              data: args["data"],
            };
            if (str(args, "record_key") !== undefined)
              body.record_key = String(args["record_key"]);
            return jsonResult(
              await client.upsertTemplateRecord(templateId, collection, body),
            );
          }
          case "update": {
            if (
              str(args, "record_key") === undefined ||
              args["data"] === undefined
            )
              return invalidArgs("update requires `record_key` and `data`");
            const body: { data: unknown; if_match?: number } = {
              data: args["data"],
            };
            if (args["if_match"] !== undefined)
              body.if_match = args["if_match"] as number;
            return jsonResult(
              await client.updateTemplateRecord(
                templateId,
                collection,
                String(args["record_key"]),
                body,
              ),
            );
          }
          case "delete": {
            if (str(args, "record_key") === undefined)
              return invalidArgs("delete requires `record_key`");
            await client.deleteTemplateRecord(
              templateId,
              collection,
              String(args["record_key"]),
              args["if_match"] !== undefined
                ? { ifMatch: args["if_match"] as number }
                : {},
            );
            return jsonResult({ deleted: true, key: args["record_key"] });
          }
          case "delete_collection": {
            if (args["confirm"] !== true) {
              return invalidArgs(
                "delete_collection drops the whole collection — pass confirm:true",
              );
            }
            await client.deleteTemplateRecordCollection(templateId, collection);
            return jsonResult({ deleted: true, collection });
          }
          default:
            return invalidArgs(`unknown template_records action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "participant",
    description:
      "Manage a pane's participant URLs (recovery + leak-containment). ONE tool with an `action` enum: list | new | revoke. Use `new` when you lost the original URL (the plaintext token is returned ONCE — save it). Token URLs are stored hashed and cannot be recovered.",
    inputSchema: participantShape,
    // Consolidated tool: read action (list) + mutating ones (new mints a URL,
    // revoke invalidates one). Hint reflects the destructive action.
    annotations: {
      title: "Manage Participants",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      const paneId = String(args["pane_id"]);
      try {
        switch (action) {
          case "list":
            return jsonResult(await client.listParticipants(paneId));
          case "new":
            return jsonResult(await client.mintParticipant(paneId));
          case "revoke":
            if (str(args, "participant_id") === undefined)
              return invalidArgs("revoke requires `participant_id`");
            await client.revokeParticipant(
              paneId,
              String(args["participant_id"]),
            );
            return jsonResult({
              pane_id: paneId,
              participant_id: args["participant_id"],
              revoked: true,
            });
          default:
            return invalidArgs(`unknown participant action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "share",
    description:
      "Identity sharing on a pane (layered on top of participant tokens). ONE tool with an `action` enum: list (access_mode + grants) | invite (a human by email, role participant|viewer) | set_access (the /p access mode: invite_only|link|public) | revoke (one grant by id). Token (/s/<token>) links are independent of access_mode and keep working.",
    inputSchema: shareShape,
    // Consolidated tool: read action (list) + mutating/side-effecting ones
    // (invite emails a human, set_access, revoke). openWorld:true because
    // invite delivers a message to an external recipient.
    annotations: {
      title: "Manage Pane Sharing",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      const paneId = String(args["pane_id"]);
      try {
        switch (action) {
          case "list":
            return jsonResult(await client.listGrants(paneId));
          case "invite": {
            if (str(args, "email") === undefined)
              return invalidArgs("invite requires `email`");
            return jsonResult(
              await client.createGrant(paneId, {
                email: String(args["email"]),
                ...(args["role"]
                  ? { role: args["role"] as "participant" | "viewer" }
                  : {}),
              }),
            );
          }
          case "set_access":
            if (str(args, "access_mode") === undefined)
              return invalidArgs("set_access requires `access_mode`");
            return jsonResult(
              await client.setPaneVisibility(
                paneId,
                args["access_mode"] as "invite_only" | "link" | "public",
              ),
            );
          case "revoke":
            if (str(args, "grant_id") === undefined)
              return invalidArgs("revoke requires `grant_id`");
            await client.revokeGrant(paneId, String(args["grant_id"]));
            return jsonResult({
              pane_id: paneId,
              grant_id: args["grant_id"],
              revoked: true,
            });
          default:
            return invalidArgs(`unknown share action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "attachments",
    description:
      "Binary attachments (images, PDFs, audio, video) referenced from event payloads / input_data via `format: pane-attachment-id`. ONE tool with an `action` enum: upload | download | show | list | delete | mint_token | revoke_token | list_tokens. upload reads an ABSOLUTE file_path; download writes to an ABSOLUTE out_path (or returns base64). Scope an upload to agent (default, reusable), pane, or template. mint_token returns a /b/<token> capability URL (ONCE) a browser can GET without your API key.",
    inputSchema: attachmentsShape,
    // Consolidated tool: read actions (download/show/list/list_tokens) +
    // mutating ones (upload/delete/mint_token/revoke_token). openWorld:true
    // because upload pushes bytes into external relay storage + mint_token
    // produces a publicly-fetchable capability URL.
    annotations: {
      title: "Manage Attachments",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "upload": {
            const filePath = str(args, "file_path");
            if (filePath === undefined)
              return invalidArgs("upload requires `file_path` (absolute)");
            const scope = (str(args, "scope") ?? "agent") as
              | "agent"
              | "pane"
              | "template";
            if (scope === "pane" && str(args, "pane_id") === undefined)
              return invalidArgs("scope=pane requires `pane_id`");
            if (scope === "template" && str(args, "template_id") === undefined)
              return invalidArgs("scope=template requires `template_id`");
            let bytes: Buffer;
            try {
              bytes = readFileSync(filePath);
            } catch (e) {
              return invalidArgs(
                `failed to read file_path '${filePath}': ${e instanceof Error ? e.message : String(e)}`,
              );
            }
            const ref = await client.uploadBlob(bytes, {
              scope,
              paneId: str(args, "pane_id"),
              templateId: str(args, "template_id"),
              filename: str(args, "filename") ?? basename(filePath),
              mime: str(args, "mime"),
            });
            return jsonResult(ref);
          }
          case "download": {
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("download requires `attachment_id`");
            const buf = await client.downloadBlob(
              String(args["attachment_id"]),
            );
            const outPath = str(args, "out_path");
            if (outPath !== undefined) {
              try {
                writeFileSync(outPath, Buffer.from(buf));
              } catch (e) {
                return invalidArgs(
                  `failed to write out_path '${outPath}': ${e instanceof Error ? e.message : String(e)}`,
                );
              }
              return jsonResult({
                attachment_id: args["attachment_id"],
                written: outPath,
                bytes: buf.byteLength,
              });
            }
            return jsonResult({
              attachment_id: args["attachment_id"],
              bytes: buf.byteLength,
              base64: Buffer.from(buf).toString("base64"),
            });
          }
          case "show":
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("show requires `attachment_id`");
            return jsonResult(
              await client.getBlob(String(args["attachment_id"])),
            );
          case "list": {
            const opts: { cursor?: string; limit?: number } = {};
            if (str(args, "cursor") !== undefined)
              opts.cursor = String(args["cursor"]);
            if (args["limit"] !== undefined)
              opts.limit = args["limit"] as number;
            return jsonResult(await client.listBlobs(opts));
          }
          case "delete":
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("delete requires `attachment_id`");
            return jsonResult(
              await client.deleteBlob(String(args["attachment_id"])),
            );
          case "mint_token": {
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("mint_token requires `attachment_id`");
            return jsonResult(
              await client.mintBlobToken(String(args["attachment_id"]), {
                ttlSeconds: args["ttl_seconds"] as number | undefined,
                once: args["once"] === true,
              }),
            );
          }
          case "revoke_token":
            if (
              str(args, "attachment_id") === undefined ||
              str(args, "token_id") === undefined
            )
              return invalidArgs(
                "revoke_token requires `attachment_id` and `token_id`",
              );
            return jsonResult(
              await client.revokeBlobToken(
                String(args["attachment_id"]),
                String(args["token_id"]),
              ),
            );
          case "list_tokens":
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("list_tokens requires `attachment_id`");
            return jsonResult(
              await client.listBlobTokens(String(args["attachment_id"])),
            );
          default:
            return invalidArgs(`unknown attachments action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "taste",
    description:
      "Read / write / clear the agent's freeform UI taste notes (a small markdown document of presentation preferences learned from human feedback — 'denser layout', 'no rounded corners'). ONE tool with an `action` enum: get | set | clear. Call `get` BEFORE generating a pane so prior feedback shapes the output; `set` does a whole-document replace (not append). Keep entries about UI/presentation only.",
    inputSchema: tasteShape,
    // Consolidated tool: read action (get) + mutating ones (set replaces the
    // doc, clear deletes it). Hint reflects the destructive action.
    annotations: {
      title: "Manage UI Taste Notes",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "get":
            return jsonResult(await client.getTaste());
          case "set": {
            const taste = str(args, "taste");
            if (taste === undefined || taste.trim() === "")
              return invalidArgs(
                "set requires non-empty `taste` (use clear to delete the notes)",
              );
            return jsonResult(await client.setTaste(taste));
          }
          case "clear":
            await client.clearTaste();
            return jsonResult({ cleared: true });
          default:
            return invalidArgs(`unknown taste action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "key",
    description:
      "Inspect or revoke the calling agent's API key. ONE tool with an `action` enum: list (key info — agent_id, key_prefix, timestamps) | revoke (self-destruct the agent's OWN key; it stops working immediately and is irreversible — pass confirm:true). The relay scopes keys to the caller, so both act only on your own key.",
    inputSchema: keyShape,
    // Consolidated tool: read action (list) + a mutating one (revoke
    // self-destructs the agent's own key). Hint reflects the destructive
    // action.
    annotations: {
      title: "Manage API Key",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "list":
            return jsonResult(await client.listKeys());
          case "revoke": {
            if (args["confirm"] !== true) {
              return invalidArgs(
                "revoke is irreversible and stops your key working immediately — pass confirm:true",
              );
            }
            const id = (await client.listKeys()).agent_id;
            await client.revokeKey(id);
            return jsonResult({ revoked: true, agent_id: id });
          }
          default:
            return invalidArgs(`unknown key action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "trash",
    description:
      "Manage soft-deleted panes + templates. ONE tool with an `action` enum: list | restore (pane id) | restore_template (template id|slug) | purge (pane id) | purge_template (template id|slug). purge bypasses the retention window and is permanent. Soft-deleted rows live in trash until the sweeper reclaims them.",
    inputSchema: trashShape,
    // Consolidated tool: read action (list) + mutating ones (restore/purge/
    // restore_template/purge_template; purge is permanent). Hint reflects the
    // destructive action.
    annotations: {
      title: "Manage Trash",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "list":
            return jsonResult(await client.listTrash());
          case "restore":
            if (str(args, "id") === undefined)
              return invalidArgs("restore requires `id` (pane id)");
            await client.restorePane(String(args["id"]));
            return jsonResult({ pane_id: args["id"], restored: true });
          case "restore_template":
            if (str(args, "id") === undefined)
              return invalidArgs(
                "restore_template requires `id` (template id|slug)",
              );
            await client.restoreTemplate(String(args["id"]));
            return jsonResult({ template_id: args["id"], restored: true });
          case "purge":
            if (str(args, "id") === undefined)
              return invalidArgs("purge requires `id` (pane id)");
            await client.permanentDeletePane(String(args["id"]));
            return jsonResult({ pane_id: args["id"], purged: true });
          case "purge_template":
            if (str(args, "id") === undefined)
              return invalidArgs(
                "purge_template requires `id` (template id|slug)",
              );
            await client.permanentDeleteTemplate(String(args["id"]));
            return jsonResult({ template_id: args["id"], purged: true });
          default:
            return invalidArgs(`unknown trash action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "feedback",
    description:
      "Send or list feedback to the relay operator. ONE tool with an `action` enum: create (a bug|feature|note with a message, optional pane_id) | list (the agent's own submissions, newest first, paginated by before).",
    inputSchema: feedbackShape,
    // Consolidated tool: read action (list) + a side-effecting one (create
    // submits feedback to the relay operator). Hint reflects the write action.
    annotations: {
      title: "Manage Feedback",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "create": {
            if (
              str(args, "type") === undefined ||
              str(args, "message") === undefined
            )
              return invalidArgs("create requires `type` and `message`");
            return jsonResult(
              await client.submitFeedback({
                type: args["type"] as "bug" | "feature" | "note",
                message: String(args["message"]),
                ...(str(args, "pane_id") !== undefined
                  ? { paneId: String(args["pane_id"]) }
                  : {}),
              }),
            );
          }
          case "list": {
            const opts: { limit?: number; before?: string } = {};
            if (args["limit"] !== undefined)
              opts.limit = args["limit"] as number;
            if (str(args, "before") !== undefined)
              opts.before = String(args["before"]);
            return jsonResult(await client.listFeedback(opts));
          }
          default:
            return invalidArgs(`unknown feedback action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "agent",
    description:
      "Agent identity + binding. ONE tool with an `action` enum: whoami (the resolved relay URL, active profile, whether a key is configured — no network, no secrets) | claim (bind this agent to a human via a one-shot claim code from their Settings UI; one-way) | logout (clear the locally-saved key/profile; does NOT revoke it on the relay — use the `key` tool's revoke for that).",
    inputSchema: agentShape,
    // Consolidated tool: read action (whoami) + mutating ones (claim binds
    // this agent to a human, logout clears the local profile). Hint reflects
    // the state-changing action.
    annotations: {
      title: "Manage Agent Identity",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args, env) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "whoami":
            // No network — pure local config introspection. The relay's HTTP
            // server injects describeConfig (active token's agent identity);
            // the stdio server reads the CLI config store.
            return jsonResult((env?.describeConfig ?? describeActiveConfig)());
          case "claim":
            if (str(args, "code") === undefined)
              return invalidArgs("claim requires `code`");
            return jsonResult(await client.claimAgent(String(args["code"])));
          case "logout":
            return jsonResult((env?.clearProfile ?? clearActiveProfile)());
          default:
            return invalidArgs(`unknown agent action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "run_query",
    description:
      "Run read-only SQL over YOUR scoped data (panes, records, events) — the relay scopes every row to panes you own. Use it to summarise activity, find panes/records by content, or build a report. Tables + columns and JSON projection operators are documented on the `sql` parameter. Default output is { columns, rows, truncated, scope, elapsed_ms } (format:json); csv/tsv/table render the rows as text. Capped at 10,000 rows; 10s timeout.",
    inputSchema: runQueryShape,
    annotations: {
      title: "Run SQL Query",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const result = await client.query(
          String(args["sql"]),
          str(args, "pane_id") !== undefined
            ? { paneId: String(args["pane_id"]) }
            : {},
        );
        const format = (str(args, "format") ?? "json") as
          | "json"
          | "csv"
          | "tsv"
          | "table";
        if (format === "json") return jsonResult(result);
        if (format === "table") return textResult(renderTable(result));
        return textResult(
          renderDelimited(result, format === "csv" ? "," : "\t"),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "get_skill",
    description:
      "Fetch the relay's auto-updating SKILL.md (the full Pane usage guide) — UNAUTHENTICATED, needs no API key. Call this to self-teach the Pane workflow (events vs records, schema grammars, the poll loop) before driving the other tools. Pass version_only:true to get just the relay's skill version string (to check if a cached copy is stale).",
    inputSchema: getSkillShape,
    annotations: {
      title: "Get Skill Guide",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (_client, args, env) => {
      try {
        const versionOnly = args["version_only"] === true;
        // The relay's HTTP server injects getSkill so MCP consumers receive
        // the MCP-invocation rendering of the skill (tool-call grammar, not
        // `pane ...` commands) straight from the relay image. The stdio server
        // falls back to fetching SKILL.md over HTTP from its configured relay.
        if (env?.getSkill) {
          const { markdown, version } = await env.getSkill(versionOnly);
          if (versionOnly) return jsonResult({ version });
          return textResult(markdown ?? "");
        }
        const url = resolveUrl();
        if (versionOnly) {
          const { version } = await fetchSkill(url, { version: true });
          return jsonResult({ version });
        }
        const { markdown } = await fetchSkill(url);
        return textResult(markdown ?? "");
      } catch (e) {
        return errorResult(e);
      }
    },
  },
];

// ===========================================================================
// run_query text renderers (mirror the CLI's csv/tsv/table formatters)
// ===========================================================================

interface QueryLike {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  scope: { kind: string; pane_count: number };
  elapsed_ms: number;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return v.toString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function escapeDelimited(sep: string, value: string): string {
  if (
    value.includes(sep) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function renderDelimited(result: QueryLike, sep: string): string {
  const lines: string[] = [];
  lines.push(result.columns.map((c) => escapeDelimited(sep, c)).join(sep));
  for (const row of result.rows) {
    lines.push(row.map((c) => escapeDelimited(sep, cell(c))).join(sep));
  }
  if (result.truncated)
    lines.push(`# truncated: capped at ${result.rows.length} rows`);
  return lines.join("\n") + "\n";
}

function renderTable(result: QueryLike): string {
  if (result.columns.length === 0) return "(no columns)\n";
  const COL_MAX = 80;
  const grid: string[][] = [result.columns.slice()];
  for (const row of result.rows) grid.push(row.map(cell));
  const widths = result.columns.map((_, ci) =>
    Math.min(COL_MAX, Math.max(...grid.map((r) => (r[ci] ?? "").length))),
  );
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => {
        const w = widths[i] ?? 0;
        const s = c.length > w ? c.slice(0, Math.max(0, w - 1)) + "…" : c;
        return s.padEnd(w);
      })
      .join(" │ ");
  const rule = "─".repeat(
    widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * 3,
  );
  const out: string[] = [fmt(grid[0]!), rule];
  for (let i = 1; i < grid.length; i++) out.push(fmt(grid[i]!));
  out.push(
    `\n${result.rows.length} row${result.rows.length === 1 ? "" : "s"}${
      result.truncated ? " (truncated; cap = 10000)" : ""
    } · scope: ${result.scope.kind} (${result.scope.pane_count} panes) · ${result.elapsed_ms}ms`,
  );
  return out.join("\n") + "\n";
}
