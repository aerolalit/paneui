#!/usr/bin/env node
// `pane-mcp` — a thin stdio Model Context Protocol server wrapping Pane.
//
// Speaks MCP over stdio so any MCP client (Claude Desktop, Cursor, …) can use
// Pane: create panes, push updates, and poll for the human's response. All
// relay I/O goes through @paneui/core (no duplicated transport logic), and
// config is shared with the `pane` CLI (~/.config/pane/config.json) — so the
// CLI and this server use the same agent identity.
//
// Config (all optional — sensible defaults; auto-registers an agent on first
// use if no key is found):
//   PANE_URL              relay base URL (default https://relay.paneui.com)
//   PANE_API_KEY          agent API key (or use the shared CLI store)
//   PANE_TOKEN            alias for PANE_API_KEY (for MCP host "*_TOKEN" config)
//   PANE_AGENT_NAME       label for the auto-registered agent
//   PANE_REGISTER_SECRET  registration secret (REGISTRATION_MODE=secret relays)

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  // --version / --help are answered locally without starting the transport, so
  // a human poking at the binary gets a useful response instead of a hung
  // stdio session waiting for JSON-RPC.
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`pane-mcp ${VERSION}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const server = buildServer({
    agentName: process.env.PANE_AGENT_NAME,
    registerSecret: process.env.PANE_REGISTER_SECRET,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stdio MCP servers run until the host closes stdin; keep the process alive.
  // The transport resolves connect() immediately, so without this the event
  // loop would otherwise stay open only because of the stdin reader — which is
  // the intended behaviour. Nothing more to do here.
}

const HELP = `pane-mcp ${VERSION} — Pane Model Context Protocol server (stdio)

Run by an MCP client over stdio; not meant to be invoked interactively. Add it
to your MCP client config, e.g. Claude Desktop / Cursor:

  {
    "mcpServers": {
      "pane": {
        "command": "npx",
        "args": ["-y", "@paneui/mcp"],
        "env": { "PANE_API_KEY": "pane_..." }
      }
    }
  }

Environment:
  PANE_URL              Relay base URL (default https://relay.paneui.com)
  PANE_API_KEY          Agent API key. If unset, the server auto-registers an
  PANE_TOKEN            agent on first use and saves the key to the shared CLI
                        store (~/.config/pane/config.json). PANE_TOKEN is an
                        alias for PANE_API_KEY.
  PANE_AGENT_NAME       Display name for the auto-registered agent.
  PANE_REGISTER_SECRET  Registration secret (REGISTRATION_MODE=secret relays).

Tools exposed (full CLI parity): create_pane, get_pane_state, get_events,
send_to_pane, update_pane, upgrade_pane, list_panes, delete_pane,
list_records, get_record, upsert_record, update_record, delete_record,
template, template_records, participant, share, attachments, taste, key,
trash, feedback, agent, run_query, get_skill.

See https://github.com/aerolalit/paneui for docs.
`;

main().catch((e) => {
  process.stderr.write(
    `pane-mcp: fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
