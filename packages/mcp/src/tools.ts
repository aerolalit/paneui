// Tool definitions for the Pane MCP server.
//
// Each tool wraps a @paneui/core PaneClient operation. The descriptions are
// written for the LLM consumer — they ARE the docs the model reads to decide
// when and how to call each tool. Keep them concrete and action-oriented.
//
// Design notes:
//   - MCP tools are request/response. There is no long-lived "watch" — instead
//     `get_events` is a poll: the model calls it with the cursor from the last
//     call until the awaited event appears. Each description spells out the
//     poll loop so the model drives it correctly.
//   - Schema validation is done with Zod raw shapes (the shape the MCP SDK's
//     registerTool expects); the SDK validates arguments against them before
//     the handler runs, so handlers receive typed, validated input.

import { z } from "zod";
import type { PaneClient } from "@paneui/core";
import { PaneApiError } from "@paneui/core";

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

/** One registered tool: name, human/LLM description, Zod input shape, handler. */
export interface ToolDef {
  name: string;
  description: string;
  // Zod raw shape — the object passed to z.object(). The MCP SDK accepts this
  // directly in registerTool({ inputSchema }) and validates arguments with it.
  inputSchema: z.ZodRawShape;
  handler: (
    client: PaneClient,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
}

/** Wrap a JSON-able value as a single text-content tool result. */
function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
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

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

const createPaneShape = {
  name: z
    .string()
    .min(1)
    .describe(
      "Short human-readable label for the auto-created template, shown in the owner UI (e.g. 'Deploy approval', 'Vendor picker').",
    ),
  html: z
    .string()
    .min(1)
    .describe(
      "The pane's UI as a complete inline HTML document. To send data back to you, the page calls window.pane.emit(eventType, payload) — every emitted eventType MUST be declared in event_schema below with 'page' in its emittedBy. Read window.pane.inputData for seed data passed via input_data.",
    ),
  event_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional. Declares which events the page (and you) may emit and validates each payload. Shape: { events: { '<type>': { emittedBy: ['page'|'agent'...], payload: <JSON Schema> } } }. OMIT for a read-only pane (dashboard/status view the human only looks at — it then accepts no events).",
    ),
  input_data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional seed data for this pane instance, readable in the page as window.pane.inputData (e.g. the diff to review, the options to pick from).",
    ),
  input_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional JSON Schema validating input_data. Only needed if input_data references uploaded attachment ids the page must download.",
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
      "Optional one/two-line context shown above the UI — 'who is asking, and why'. Use it whenever the pane isn't self-explanatory.",
    ),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional pane lifetime in seconds. The relay clamps to its max; the returned expires_at is authoritative.",
    ),
  context_key: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Optional natural key (e.g. 'pr-42', 'deal-1138'). Repeated create_pane calls with the same (template, key) return the SAME pane instead of a new one — use it to make retries idempotent.",
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
      "Optional long-poll: how long the relay holds the request open waiting for a new event (0–30s, relay-capped). Use ~25 when waiting for a human to act, so each poll either returns promptly with the event or returns empty and you call again with the same cursor.",
    ),
};

const sendToPaneShape = {
  pane_id: z.string().min(1).describe("The pane id to push the event into."),
  type: z
    .string()
    .min(1)
    .describe(
      "Event type. Must be declared in the pane's event_schema with 'agent' in its emittedBy list (the page sees it live).",
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
    .describe("Optional cursor (next_since from a prior call) for pagination."),
  limit: z.number().int().positive().optional().describe("Optional page size."),
};

const upsertRecordShape = {
  pane_id: z.string().min(1).describe("The pane id."),
  collection: z.string().min(1).describe("The record collection name."),
  record_key: z
    .string()
    .optional()
    .describe(
      "Optional stable key for this record. Reusing an existing key returns the existing row (deduped:true) rather than creating a duplicate; omit to let the relay assign one.",
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
      "Optional optimistic-lock version. If it doesn't match the current row, the update is rejected with the current row in details.current.",
    ),
};

const deleteRecordShape = {
  pane_id: z.string().min(1).describe("The pane id."),
  collection: z.string().min(1).describe("The record collection name."),
  record_key: z.string().min(1).describe("The key of the record to delete."),
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  {
    name: "create_pane",
    description:
      "Hand the human a rich interactive UI by URL and (optionally) get structured data back. Build the UI as inline HTML; the relay hosts it and returns a URL. ALWAYS give the returned url (result.url) to the human — paste it into the conversation and ask them to open it. Reach for this whenever a text reply is the wrong shape: forms, approvals, pickers, surveys, dashboards, diff/doc review, multi-step wizards. If the page captures input it emits events back to you (poll them with get_events). A read-only dashboard with no event_schema is valid too. Returns { pane_id, url, expires_at }.",
    inputSchema: createPaneShape,
    handler: async (client, args) => {
      try {
        const template: Record<string, unknown> = {
          name: args["name"],
          type: "html-inline",
          source: args["html"],
        };
        if (args["event_schema"] !== undefined)
          template["event_schema"] = args["event_schema"];
        if (args["input_schema"] !== undefined)
          template["input_schema"] = args["input_schema"];

        const req: Record<string, unknown> = { template };
        if (args["input_data"] !== undefined)
          req["input_data"] = args["input_data"];
        if (args["title"] !== undefined) req["title"] = args["title"];
        if (args["preamble"] !== undefined) req["preamble"] = args["preamble"];
        if (args["ttl_seconds"] !== undefined) req["ttl"] = args["ttl_seconds"];
        if (args["context_key"] !== undefined)
          req["context_key"] = args["context_key"];

        const res = await client.createPane(
          req as Parameters<PaneClient["createPane"]>[0],
        );
        const humanUrl = res.urls.humans[0] ?? null;
        return jsonResult({
          pane_id: res.pane_id,
          // The single URL to deliver to the human. (urls.humans carries all
          // of them when participants > 1.)
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
    handler: async (client, args) => {
      try {
        const state = await client.getPane(String(args["pane_id"]));
        return jsonResult(state);
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
    name: "list_records",
    description:
      "List rows in a pane's mutable record collection (e.g. a todo list, shopping list, kanban board, comment thread). Records are the right primitive when the page shows several mutable items and the CURRENT state matters more than the history of edits. Includes tombstones (deleted_at set) so you can observe deletions. Returns { records, next_since, has_more }.",
    inputSchema: listRecordsShape,
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
        return jsonResult(out);
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "upsert_record",
    description:
      "Create a row in a pane's record collection, or return the existing row if record_key is already present (deduped:true). Use to add a todo, a line item, a comment, etc. The collection must be declared in the pane's record schema with 'agent' allowed to write. Returns { record, deduped }.",
    inputSchema: upsertRecordShape,
    handler: async (client, args) => {
      try {
        const body: { record_key?: string; data: unknown } = {
          data: args["data"],
        };
        if (args["record_key"] !== undefined)
          body.record_key = String(args["record_key"]);
        const out = await client.upsertRecord(
          String(args["pane_id"]),
          String(args["collection"]),
          body,
        );
        return jsonResult(out);
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
    handler: async (client, args) => {
      try {
        const body: { data: unknown; if_match?: number } = {
          data: args["data"],
        };
        if (args["if_match"] !== undefined)
          body.if_match = args["if_match"] as number;
        const out = await client.updateRecord(
          String(args["pane_id"]),
          String(args["collection"]),
          String(args["record_key"]),
          body,
        );
        return jsonResult(out);
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "delete_record",
    description:
      "Soft-delete a row from a pane's record collection. The page sees the deletion live (the row becomes a tombstone in list_records). Returns { deleted: true }.",
    inputSchema: deleteRecordShape,
    handler: async (client, args) => {
      try {
        await client.deleteRecord(
          String(args["pane_id"]),
          String(args["collection"]),
          String(args["record_key"]),
        );
        return jsonResult({ deleted: true });
      } catch (e) {
        return errorResult(e);
      }
    },
  },
];
