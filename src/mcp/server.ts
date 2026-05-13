#!/usr/bin/env node
// pane-mcp: an MCP server (stdio transport) that exposes three tools backed
// by a running Pane relay. The host (e.g. Claude Desktop, a claw) spawns
// this binary; we hold PANE_URL + PANE_API_KEY and translate tool calls
// into HTTP requests against the relay.
//
// Tools:
//   create_pane_session(artifact, schema, ...) -> { session_id, urls, tokens, expires_at }
//   await_pane_result(session_id, terminal_event_type, timeout_seconds?) -> { status, event? }
//   get_pane_state(session_id, since?) -> { meta, events, next_cursor }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PANE_URL = (process.env.PANE_URL ?? "").replace(/\/$/, "");
const PANE_API_KEY = process.env.PANE_API_KEY ?? "";

if (!PANE_URL || !PANE_API_KEY) {
  process.stderr.write("pane-mcp: PANE_URL and PANE_API_KEY must both be set\n");
  process.exit(1);
}

interface RelayResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

async function call(method: string, path: string, body?: object): Promise<RelayResponse> {
  const url = PANE_URL + path;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: "Bearer " + PANE_API_KEY,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cause = (e as { cause?: { code?: string; message?: string } } | undefined)?.cause;
    process.stderr.write(
      `pane-mcp: fetch ${method} ${url} threw: ${msg}` +
        (cause ? ` (cause: ${cause.code ?? ""} ${cause.message ?? ""})` : "") +
        "\n",
    );
    return {
      ok: false,
      status: 0,
      data: { error: { code: "fetch_error", message: msg } },
    };
  }
  let data: unknown = null;
  if (res.status !== 204) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: { [x: string]: unknown };
  isError?: boolean;
}

function mapError(r: RelayResponse): ToolResult {
  const err = (r.data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  let msg = `relay returned ${r.status}`;
  if (err?.code) msg += ` (${err.code})`;
  if (err?.message) msg += `: ${err.message}`;
  const detailsBlock = err?.details ? "\n" + JSON.stringify(err.details, null, 2) : "";
  return {
    isError: true,
    content: [{ type: "text", text: msg + detailsBlock }],
  };
}

function ok(value: unknown): ToolResult {
  const text = JSON.stringify(value, null, 2);
  const structured: { [x: string]: unknown } =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { [x: string]: unknown })
      : { value };
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

const server = new McpServer(
  { name: "pane-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.registerTool(
  "create_pane_session",
  {
    title: "Create Pane session",
    description:
      "Create a Pane session: bundle an HTML/JS artifact with a per-session event schema. " +
      "Returns the URL(s) to deliver to humans plus an agent token for the WS stream.",
    inputSchema: {
      artifact: z.object({
        type: z.enum(["html-inline", "html-ref"]),
        source: z.string().min(1),
      }),
      schema: z.record(z.unknown()),
      participants: z.object({ humans: z.number().int().positive() }).optional(),
      ttl_seconds: z.number().int().positive().optional(),
      metadata: z.record(z.unknown()).optional(),
      callback: z
        .object({
          url: z.string().url(),
          events: z.array(z.string()).min(1),
          secret: z.string().min(8),
        })
        .optional(),
    },
  },
  async (args) => {
    const r = await call("POST", "/v1/sessions", {
      artifact: args.artifact,
      schema: args.schema,
      participants: args.participants,
      ttl: args.ttl_seconds,
      metadata: args.metadata,
      callback: args.callback,
    });
    return r.ok ? ok(r.data) : mapError(r);
  },
);

server.registerTool(
  "await_pane_result",
  {
    title: "Await Pane result",
    description:
      "Block until an event of `terminal_event_type` arrives on the session " +
      "(or `timeout_seconds` elapses, or the session closes). " +
      "Returns the matching event envelope on success.",
    inputSchema: {
      session_id: z.string().min(1),
      terminal_event_type: z.string().min(1),
      timeout_seconds: z.number().int().positive().max(3600).optional(),
    },
  },
  async (args) => {
    const timeoutMs = (args.timeout_seconds ?? 300) * 1000;
    const start = Date.now();
    let cursor: string | null = null;
    while (Date.now() - start < timeoutMs) {
      const remaining = Math.max(
        1,
        Math.min(30, Math.floor((timeoutMs - (Date.now() - start)) / 1000)),
      );
      const q = new URLSearchParams();
      if (cursor) q.set("since", cursor);
      q.set("wait", String(remaining));
      const r = await call(
        "GET",
        `/v1/sessions/${encodeURIComponent(args.session_id)}/events?${q.toString()}`,
      );
      if (!r.ok) return mapError(r);
      const body = r.data as {
        events: Array<{ id: string; type: string; [k: string]: unknown }>;
        next_cursor: string | null;
      };
      for (const ev of body.events) {
        if (ev.type === args.terminal_event_type) {
          return ok({ status: "received", event: ev });
        }
      }
      cursor = body.next_cursor ?? cursor;
      // Quick session-status check: if it closed, bail out early.
      const meta = await call("GET", `/v1/sessions/${encodeURIComponent(args.session_id)}`);
      if (meta.ok) {
        const status = (meta.data as { status?: string } | null)?.status;
        if (status && status !== "open") return ok({ status: "closed" });
      }
    }
    return ok({ status: "timeout" });
  },
);

server.registerTool(
  "get_pane_state",
  {
    title: "Get Pane session state",
    description:
      "Non-blocking. Returns session metadata + the event log (from `since` if provided).",
    inputSchema: {
      session_id: z.string().min(1),
      since: z.string().optional(),
    },
  },
  async (args) => {
    const meta = await call("GET", `/v1/sessions/${encodeURIComponent(args.session_id)}`);
    if (!meta.ok) return mapError(meta);
    const q = args.since ? `?since=${encodeURIComponent(args.since)}` : "";
    const events = await call(
      "GET",
      `/v1/sessions/${encodeURIComponent(args.session_id)}/events${q}`,
    );
    if (!events.ok) return mapError(events);
    return ok({
      meta: meta.data,
      events: (events.data as { events: unknown[] }).events,
      next_cursor: (events.data as { next_cursor: string | null }).next_cursor,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`pane-mcp: connected to ${PANE_URL}\n`);
