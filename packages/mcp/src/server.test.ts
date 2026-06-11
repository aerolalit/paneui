// End-to-end MCP handshake test: a real MCP Client speaks to the Pane server
// over an in-memory transport pair. Exercises initialize → tools/list →
// tools/call exactly as a host (Claude Desktop / Cursor) would, against an
// injected fake PaneClient so no network or config store is touched.

import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PaneClient } from "@paneui/core";
import { buildServer } from "./server.js";

/** Wire a Client to a freshly-built server over a linked in-memory pair. */
async function connect(client: PaneClient) {
  const server = buildServer({ client });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
  return mcpClient;
}

function fakeClient(overrides: Record<string, unknown>): PaneClient {
  return overrides as unknown as PaneClient;
}

describe("MCP handshake", () => {
  it("lists every Pane tool over tools/list", async () => {
    const mcp = await connect(fakeClient({}));
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("create_pane");
    expect(names).toContain("get_events");
    expect(names).toContain("send_to_pane");
    expect(names).toContain("upsert_record");
    expect(names).toHaveLength(8);
    // Each advertised tool carries a description + JSON-schema inputSchema the
    // host shows to the model.
    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it("rejects tools/call with invalid arguments before hitting core", async () => {
    const createPane = vi.fn();
    const mcp = await connect(fakeClient({ createPane }));
    // Missing required `html` — the SDK validates against the input schema and
    // returns an isError result without ever invoking the handler.
    const result = (await mcp.callTool({
      name: "create_pane",
      arguments: { name: "X" },
    })) as { content: { type: string; text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/validation|html/i);
    expect(createPane).not.toHaveBeenCalled();
  });

  it("round-trips create_pane through to the injected client", async () => {
    const createPane = vi.fn().mockResolvedValue({
      pane_id: "pan_rt",
      tokens: { humans: ["t"], agent: "a" },
      urls: { humans: ["https://relay.test/s/tok"], agent_stream: "ws" },
      title: "Pick a slot",
      expires_at: "2026-02-02T00:00:00Z",
    });
    const mcp = await connect(fakeClient({ createPane }));
    const result = (await mcp.callTool({
      name: "create_pane",
      arguments: { name: "Pick a slot", html: "<form></form>" },
    })) as { content: { type: string; text: string }[]; isError?: boolean };

    expect(result.isError).toBeFalsy();
    expect(createPane).toHaveBeenCalledTimes(1);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.pane_id).toBe("pan_rt");
    expect(body.url).toBe("https://relay.test/s/tok");
  });
});
