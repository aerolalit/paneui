// Streamable-HTTP MCP endpoint at /mcp, protected by the relay's OAuth 2.1 AS.
//
// Architecture (resource server + auth server both on the relay):
//   - The MCP transport is the SDK's WebStandardStreamableHTTPServerTransport,
//     which speaks Web Standard Request/Response — a clean fit for Hono
//     (c.req.raw in, Response out), no Node req/res bridging.
//   - Capability discovery (initialize, tools/list, prompts/list,
//     resources/list, notifications) works WITHOUT a token so Claude can
//     enumerate the connector before the human consents.
//   - tools/call (and any other privileged method) REQUIRES a valid access
//     token. A missing/invalid token on a privileged call → 401 with
//     WWW-Authenticate pointing at the protected-resource metadata, which is
//     the signal Claude follows into the OAuth flow.
//   - Each authenticated request carries its identity via the transport's
//     authInfo; the tool handlers read it and build a PaneClient keyed as the
//     mapped agent, looping back to the relay's own HTTP API (localhost). This
//     reuses EVERY existing relay auth/validation/scoping path — the OAuth
//     agent acts exactly as a CLI agent would. (An in-process service path was
//     considered; the loopback keeps the 26 tool handlers untouched and routes
//     through the same middleware, which is the safer reuse.)
//
// Sessions: stateful. A session id is issued on initialize (Mcp-Session-Id)
// and validated on subsequent requests; one McpServer+transport pair is kept
// per session. The PaneClient is NOT bound to the session — it is rebuilt per
// request from that request's authInfo — so a session created during the
// unauthenticated discovery phase still acts as the agent once tokens arrive.

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { PaneClient } from "@paneui/core";
import { TOOLS, type ToolEnv } from "@paneui/mcp/tools";
import { registerGuideCapabilities } from "@paneui/mcp/capabilities";
import type { AppEnv } from "../env.js";
import { verifyMcpAccessToken } from "./oauth.js";
import { MCP_GUIDE, MCP_GUIDE_VERSION } from "../../mcp/guide.js";
import { log } from "../../log.js";

// JSON-RPC methods that DON'T require auth (capability discovery + lifecycle).
// Everything else (notably tools/call) requires a valid access token.
const PUBLIC_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/templates/list",
  "ping",
]);

// Per-session transport+server. Keyed by Mcp-Session-Id.
interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  // Last time a request touched this session — for idle eviction.
  lastSeenAt: number;
}
const sessions = new Map<string, Session>();

/**
 * Bound the in-memory session map so unauthenticated `initialize` (capability
 * discovery is token-free) can't grow it without limit (memory DoS). Called on
 * every request before routing:
 *
 *   1. Sweep sessions idle longer than `idleTtlMs` — close + drop them.
 *   2. If still at/over `maxSessions`, evict the least-recently-seen sessions
 *      until under the cap (making room for the incoming one).
 *
 * `maxSessions <= 0` disables the cap; `idleTtlMs <= 0` disables idle sweeping.
 */
function evictSessions(maxSessions: number, idleTtlMs: number): void {
  const now = Date.now();
  if (idleTtlMs > 0) {
    for (const [id, s] of sessions) {
      if (now - s.lastSeenAt > idleTtlMs) {
        try {
          void s.transport.close?.();
        } catch {
          // best effort — drop the entry regardless
        }
        sessions.delete(id);
      }
    }
  }
  if (maxSessions > 0 && sessions.size >= maxSessions) {
    // Evict oldest-first until we're under the cap (leave room for one more).
    const ordered = [...sessions.entries()].sort(
      (a, b) => a[1].lastSeenAt - b[1].lastSeenAt,
    );
    let over = sessions.size - maxSessions + 1;
    for (const [id, s] of ordered) {
      if (over <= 0) break;
      try {
        void s.transport.close?.();
      } catch {
        // best effort
      }
      sessions.delete(id);
      over--;
    }
  }
}

/**
 * Build an McpServer bound to a per-request auth holder. The tool handlers
 * read the CURRENT request's authInfo (set just before handleRequest) to build
 * a PaneClient keyed as that request's agent.
 */
function buildMcpServer(
  loopbackUrl: string,
  authHolder: { current: AuthInfo | undefined },
): McpServer {
  const server = new McpServer({ name: "pane", version: MCP_GUIDE_VERSION });

  // get_skill / agent are resolved server-side (no CLI config on disk).
  const toolEnv: ToolEnv = {
    getSkill: async (versionOnly) =>
      versionOnly ? { version: MCP_GUIDE_VERSION } : { markdown: MCP_GUIDE },
    describeConfig: () => {
      const a = authHolder.current;
      return {
        url: loopbackUrl,
        profile: "oauth",
        api_key_present: a !== undefined,
        agent_id: a?.extra?.["agentId"] ?? null,
        client_id: a?.clientId ?? null,
      };
    },
    // logout is meaningless for a remote token (disconnect = revoke the token
    // from settings); expose a clear message rather than a destructive no-op.
    clearProfile: () => ({
      ok: false,
      message:
        "This is a remote MCP connection. Disconnect it from your pane settings (which revokes the token) rather than logging out here.",
    }),
  };

  registerGuideCapabilities(server, () => MCP_GUIDE);

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args, extra) => {
        // The auth holder is the source of truth for this request's identity;
        // fall back to extra.authInfo (set by the transport) for safety.
        const auth = authHolder.current ?? extra.authInfo;
        const apiKey =
          (auth?.extra?.["agentApiKey"] as string | undefined) ?? undefined;
        if (!apiKey) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "unauthorized",
                    message:
                      "this tool requires an authenticated pane connection",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        const client = new PaneClient({ url: loopbackUrl, apiKey });
        return tool.handler(client, args, toolEnv);
      },
    );
  }

  return server;
}

/**
 * Mount the MCP route. `app` is the relay app; `loopbackUrl` is where the
 * tool-handler PaneClient sends its requests (the relay's own origin —
 * publicUrl, or http://127.0.0.1:PORT for a same-process loopback).
 */
export function mountMcp(app: Hono<AppEnv>, loopbackUrl: string): void {
  // Permissive CORS for the MCP path + expose the session header so a browser
  // MCP client (and Claude's web client) can read it.
  app.use("/mcp", async (c, next) => {
    c.header("Access-Control-Allow-Origin", c.req.header("origin") ?? "*");
    c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id",
    );
    c.header(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id, WWW-Authenticate",
    );
    c.header("Access-Control-Max-Age", "86400");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  });

  app.all("/mcp", async (c) => {
    const prisma = c.get("prisma");
    const config = c.get("config");
    const req = c.req.raw;

    // Resolve auth (if any). A token is OPTIONAL for discovery; required for
    // privileged methods (enforced below after we know the method).
    let authInfo: AuthInfo | undefined;
    let tokenPresent = false;
    let tokenValid = false;
    const authHeader = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (m) {
      tokenPresent = true;
      const resolved = await verifyMcpAccessToken(
        prisma,
        m[1]!.trim(),
        `${config.publicUrl}/mcp`,
      );
      if (resolved) {
        tokenValid = true;
        authInfo = {
          token: m[1]!.trim(),
          clientId: resolved.clientId,
          scopes: [resolved.scope],
          expiresAt: resolved.expiresAt,
          resource: new URL(`${config.publicUrl}/mcp`),
          extra: {
            agentId: resolved.agentId,
            humanId: resolved.humanId,
            agentApiKey: resolved.agentApiKey,
          },
        };
      }
    }

    // Peek the request method to decide whether auth is required. Only POST
    // bodies carry JSON-RPC; GET (SSE) + DELETE (session teardown) ride an
    // established session and don't need the auth gate beyond a valid session.
    let rpcMethod: string | undefined;
    let parsedBody: unknown;
    if (c.req.method === "POST") {
      try {
        parsedBody = await req.clone().json();
      } catch {
        parsedBody = undefined;
      }
      if (parsedBody && typeof parsedBody === "object") {
        const maybe = Array.isArray(parsedBody) ? parsedBody[0] : parsedBody;
        if (maybe && typeof maybe === "object" && "method" in maybe) {
          rpcMethod = String((maybe as { method: unknown }).method);
        }
      }
    }

    // 401 challenge: a privileged method with no valid token. Either no token
    // at all on a tools/call, or a present-but-invalid/expired token (always
    // challenge so Claude restarts OAuth).
    const privileged =
      rpcMethod !== undefined && !PUBLIC_METHODS.has(rpcMethod);
    if ((privileged && !tokenValid) || (tokenPresent && !tokenValid)) {
      const resourceMeta = `${config.publicUrl}/.well-known/oauth-protected-resource`;
      c.header(
        "WWW-Authenticate",
        `Bearer realm="pane", resource_metadata="${resourceMeta}"`,
      );
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "authentication required",
          },
          id:
            parsedBody &&
            typeof parsedBody === "object" &&
            "id" in (parsedBody as object)
              ? (parsedBody as { id: unknown }).id
              : null,
        },
        401,
      );
    }

    // Session routing.
    const sessionId = req.headers.get("mcp-session-id") ?? undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    const isInitialize = rpcMethod === "initialize";

    // Bound the in-memory session map BEFORE potentially creating a new session
    // — unauthenticated `initialize` is what grows it, so cap + idle-evict here
    // so a flood of discovery sessions can't exhaust memory.
    if (!session && isInitialize) {
      evictSessions(
        config.MCP_MAX_SESSIONS,
        config.MCP_SESSION_IDLE_TTL_SECONDS * 1000,
      );
    }

    if (!session) {
      if (sessionId && !isInitialize) {
        // Unknown session on a non-initialize request → 404 (the SDK transport
        // would do the same; we short-circuit to a clean JSON-RPC error).
        return c.json(
          {
            jsonrpc: "2.0",
            error: { code: -32000, message: "session not found" },
            id: null,
          },
          404,
        );
      }
      if (!isInitialize && c.req.method === "POST") {
        return c.json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "no session: send initialize first",
            },
            id: null,
          },
          400,
        );
      }
      // Create a fresh session (initialize, or a GET/DELETE that the transport
      // will validate). The auth holder is mutated per request below.
      const authHolder: { current: AuthInfo | undefined } = {
        current: authInfo,
      };
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, lastSeenAt: Date.now() });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      const server = buildMcpServer(loopbackUrl, authHolder);
      // Stash the holder on the transport so subsequent requests for this
      // session update the SAME holder the server closed over.
      (transport as unknown as { _authHolder: typeof authHolder })._authHolder =
        authHolder;
      await server.connect(transport);
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      session = { transport, server, lastSeenAt: Date.now() };
      // Note: not yet in `sessions` until onsessioninitialized fires with the
      // generated id; the transport returns the id in the response header.
    } else {
      // Existing session — refresh the auth holder so this request's identity
      // is what the tool handlers see, and bump its idle clock.
      session.lastSeenAt = Date.now();
      const holder = (
        session.transport as unknown as {
          _authHolder?: { current: AuthInfo | undefined };
        }
      )._authHolder;
      if (holder) holder.current = authInfo;
    }

    // Delegate to the transport. It reads/writes the Web Standard request and
    // returns a Web Standard Response (status, headers incl. Mcp-Session-Id,
    // and the JSON or SSE body). Pass the pre-parsed body so we don't re-read
    // the (already-consumed-by-clone) stream, and the authInfo for handlers.
    return session.transport.handleRequest(req, {
      parsedBody,
      authInfo,
    });
  });

  log.info("mcp endpoint mounted", { path: "/mcp", loopback: loopbackUrl });
}

/**
 * Test-only window into the in-memory session map. NOT for production code —
 * the map is process-global module state, exposed here so the e2e can assert
 * the cap + idle-eviction behaviour without reaching into module internals.
 */
export const _sessionsForTests = {
  size: (): number => sessions.size,
  clear: (): void => sessions.clear(),
};
