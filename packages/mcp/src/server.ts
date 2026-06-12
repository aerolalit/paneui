// Builds the Pane MCP server: registers every tool from ./tools.ts against an
// McpServer and wires each handler to a lazily-resolved PaneClient.
//
// The PaneClient is resolved ONCE, on the first tool call, then cached — so the
// (potentially network-touching) auto-register-on-first-use path runs lazily,
// not at process start. This keeps `initialize` / `tools/list` fast and offline
// (an MCP host can enumerate the tools without the relay being reachable), and
// only the first actual tool call provisions a key if needed.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PaneClient } from "@paneui/core";
import { resolveClient, resolveUrl } from "./config.js";
import { TOOLS, type ToolEnv } from "./tools.js";
import { VERSION } from "./version.js";
import { fetchMcpGuide } from "./skill.js";
import { registerGuideCapabilities } from "./capabilities.js";

export interface BuildServerOptions {
  /** Display name for the auto-registered agent (when no key is configured). */
  agentName?: string;
  /** Registration secret for REGISTRATION_MODE=secret relays. */
  registerSecret?: string;
  /**
   * Inject a pre-built client (tests). When set, the lazy resolver is skipped
   * entirely and no network/store access happens.
   */
  client?: PaneClient;
}

/**
 * Construct (but do not connect) the Pane MCP server. Call `.connect(transport)`
 * on the returned server to start serving.
 */
export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "pane",
    version: VERSION,
  });

  // Lazily resolve + memoise the client. A failed resolution is not cached, so
  // a transient error (e.g. relay unreachable during auto-register) can be
  // retried on the next tool call.
  let clientPromise: Promise<PaneClient> | undefined;
  const getClient = (): Promise<PaneClient> => {
    if (opts.client) return Promise.resolve(opts.client);
    if (clientPromise === undefined) {
      clientPromise = resolveClient({
        agentName: opts.agentName,
        registerSecret: opts.registerSecret,
      }).catch((e) => {
        clientPromise = undefined;
        throw e;
      });
    }
    return clientPromise;
  };

  // MCP consumers get the MCP-flavoured guide (tool-call grammar), not the
  // CLI-grammar SKILL.md. get_skill fetches /skills/pane/MCP.md from the
  // configured relay; everything else keeps its CLI defaults (the stdio server
  // reads identity from the shared CLI config store).
  const toolEnv: ToolEnv = {
    getSkill: (versionOnly) =>
      fetchMcpGuide(resolveUrl(), { version: versionOnly }),
  };

  // Conceptual guide as an MCP prompt + resource. Fetched from the relay lazily
  // on read; a relay-unreachable read surfaces a short pointer to get_skill
  // rather than failing registration.
  registerGuideCapabilities(server, async () => {
    try {
      const { markdown } = await fetchMcpGuide(resolveUrl());
      return markdown ?? "";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return (
        "# pane\n\nThe pane guide could not be fetched from the relay " +
        `(${message}).\n\nCall the \`get_skill\` tool to retrieve it once the ` +
        "relay is reachable.\n"
      );
    }
  });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        // `title` (top-level, display name) + `annotations` (the ToolAnnotations
        // behavioural hints, which also carry a title) both flow into tools/list
        // so MCP hosts / Anthropic's connector directory can classify the tool.
        title: tool.annotations.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => {
        let client: PaneClient;
        try {
          client = await getClient();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "config_error",
                    message,
                    hint: "Set PANE_API_KEY (or PANE_TOKEN), or ensure the relay at PANE_URL is reachable so the server can auto-register an agent.",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        return tool.handler(client, args, toolEnv);
      },
    );
  }

  return server;
}
