// Register pane's MCP prompt + resource on an McpServer.
//
// Both the stdio server (packages/mcp/src/server.ts) and the relay's HTTP MCP
// server call this so an MCP-native client can discover the conceptual guide
// without a tool call:
//
//   - prompt   `pane_guide`   — surfaces the guide as a prompt the client can
//                               insert into context ("teach me pane").
//   - resource `pane://guide`  — the same guide as a readable resource.
//
// The guide text is supplied by the host: the relay composes it in-process
// (MCP-INVOCATION.md + the core extracted from SKILL.md); the stdio server
// fetches it from the relay over HTTP and falls back to a short pointer when
// the relay is unreachable at registration time (registration must not block on
// the network — the get_skill tool is the always-fresh path).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const GUIDE_RESOURCE_URI = "pane://guide";
export const GUIDE_PROMPT_NAME = "pane_guide";

/**
 * Register the `pane_guide` prompt and the `pane://guide` resource on `server`.
 * `getGuide()` returns the current MCP-flavoured guide markdown (called lazily
 * on each read so a relay can serve an updated guide without re-registering).
 */
export function registerGuideCapabilities(
  server: McpServer,
  getGuide: () => string | Promise<string>,
): void {
  server.registerResource(
    GUIDE_PROMPT_NAME,
    GUIDE_RESOURCE_URI,
    {
      title: "Pane usage guide",
      description:
        "The pane conceptual guide for MCP clients: when to use pane, events vs records, schema design, the house style, and the round-trip mental model — with MCP tool-call invocation grammar.",
      mimeType: "text/markdown",
    },
    async () => {
      const text = await getGuide();
      return {
        contents: [
          { uri: GUIDE_RESOURCE_URI, mimeType: "text/markdown", text },
        ],
      };
    },
  );

  server.registerPrompt(
    GUIDE_PROMPT_NAME,
    {
      title: "Pane usage guide",
      description:
        "Insert the pane usage guide (MCP invocation + conceptual core) into the conversation so the model knows how to drive pane's tools.",
    },
    async () => {
      const text = await getGuide();
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text },
          },
        ],
      };
    },
  );
}
