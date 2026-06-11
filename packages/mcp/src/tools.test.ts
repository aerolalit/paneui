// Tests for the Pane MCP tool layer.
//
// Three concerns, matching the repo's test style (vitest, mocked deps):
//   1. tool listing — the server advertises the expected tool set with
//      non-empty descriptions and input schemas (the descriptions are the
//      docs the LLM reads, so an empty one is a real bug).
//   2. schema validation — Zod input shapes reject bad input and accept good.
//   3. mocked-core round trip — each handler maps its args onto the right
//      PaneClient call and shapes the result/errors as the model expects.

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { PaneApiError } from "@paneui/core";
import { TOOLS } from "./tools.js";

/** Find a tool by name (throws if absent — keeps the tests honest). */
function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool '${name}' not registered`);
  return t;
}

/** A PaneClient stub: every method is a vi.fn; cast to satisfy the handler. */
function fakeClient(overrides: Record<string, unknown> = {}) {
  return overrides as unknown as Parameters<
    (typeof TOOLS)[number]["handler"]
  >[0];
}

describe("tool listing", () => {
  it("exposes exactly the expected tool set", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "create_pane",
        "delete_record",
        "get_events",
        "get_pane_state",
        "list_records",
        "send_to_pane",
        "update_record",
        "upsert_record",
      ].sort(),
    );
  });

  it("every tool has a non-empty description and an input schema", () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(typeof t.inputSchema).toBe("object");
      // The shape must be a Zod raw shape (record of ZodType).
      expect(Object.keys(t.inputSchema).length).toBeGreaterThan(0);
    }
  });

  it("create_pane tells the model to deliver the URL to the human", () => {
    // Load-bearing: the whole point of the MCP server is that the model hands
    // the human the URL. If this guidance drops out of the description the
    // round trip silently breaks.
    expect(tool("create_pane").description.toLowerCase()).toContain("url");
    expect(tool("create_pane").description.toLowerCase()).toContain("human");
  });

  it("get_events documents the poll pattern (no streaming in MCP)", () => {
    expect(tool("get_events").description.toLowerCase()).toContain("poll");
    expect(tool("get_events").description.toLowerCase()).toContain("cursor");
  });
});

describe("schema validation", () => {
  it("create_pane requires name + html", () => {
    const schema = z.object(tool("create_pane").inputSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ name: "X" }).success).toBe(false);
    expect(schema.safeParse({ name: "X", html: "<h1>hi</h1>" }).success).toBe(
      true,
    );
  });

  it("create_pane rejects an empty name", () => {
    const schema = z.object(tool("create_pane").inputSchema);
    expect(schema.safeParse({ name: "", html: "<h1>x</h1>" }).success).toBe(
      false,
    );
  });

  it("get_events caps wait_seconds at 30", () => {
    const schema = z.object(tool("get_events").inputSchema);
    expect(schema.safeParse({ pane_id: "p", wait_seconds: 25 }).success).toBe(
      true,
    );
    expect(schema.safeParse({ pane_id: "p", wait_seconds: 60 }).success).toBe(
      false,
    );
  });

  it("send_to_pane requires pane_id + type", () => {
    const schema = z.object(tool("send_to_pane").inputSchema);
    expect(schema.safeParse({ data: {} }).success).toBe(false);
    expect(
      schema.safeParse({ pane_id: "p", type: "progress", data: { pct: 50 } })
        .success,
    ).toBe(true);
  });
});

describe("mocked-core round trip", () => {
  it("create_pane maps args onto client.createPane and returns the human URL", async () => {
    const createPane = vi.fn().mockResolvedValue({
      pane_id: "pan_1",
      tokens: { humans: ["t"], agent: "a" },
      urls: {
        humans: ["https://relay.test/s/tok_h"],
        agent_stream: "wss://relay.test/stream",
      },
      title: "Deploy approval",
      expires_at: "2026-01-01T00:00:00Z",
    });

    const res = await tool("create_pane").handler(fakeClient({ createPane }), {
      name: "Deploy approval",
      html: "<h1>Approve?</h1>",
      event_schema: { events: {} },
      title: "Deploy approval",
      ttl_seconds: 600,
      context_key: "deploy-42",
    });

    // The inline template form is assembled correctly.
    expect(createPane).toHaveBeenCalledTimes(1);
    const req = createPane.mock.calls[0]![0];
    expect(req.template).toEqual({
      name: "Deploy approval",
      type: "html-inline",
      source: "<h1>Approve?</h1>",
      event_schema: { events: {} },
    });
    expect(req.ttl).toBe(600);
    expect(req.context_key).toBe("deploy-42");

    // The result surfaces the URL to deliver to the human.
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.pane_id).toBe("pan_1");
    expect(body.url).toBe("https://relay.test/s/tok_h");
    expect(body.expires_at).toBe("2026-01-01T00:00:00Z");
  });

  it("create_pane omits event_schema when not provided (view-only pane)", async () => {
    const createPane = vi.fn().mockResolvedValue({
      pane_id: "pan_2",
      tokens: { humans: ["t"], agent: "a" },
      urls: { humans: ["https://relay.test/s/x"], agent_stream: "ws" },
      title: "Dashboard",
      expires_at: "2026-01-01T00:00:00Z",
    });
    await tool("create_pane").handler(fakeClient({ createPane }), {
      name: "Dashboard",
      html: "<h1>status</h1>",
    });
    const req = createPane.mock.calls[0]![0];
    expect("event_schema" in req.template).toBe(false);
    expect("input_schema" in req.template).toBe(false);
  });

  it("get_events forwards since + wait_seconds to client.getEvents", async () => {
    const getEvents = vi.fn().mockResolvedValue({
      events: [{ id: "ev_1", type: "approved", data: { ok: true } }],
      next_cursor: "c2",
    });
    const res = await tool("get_events").handler(fakeClient({ getEvents }), {
      pane_id: "pan_1",
      since: "c1",
      wait_seconds: 25,
    });
    expect(getEvents).toHaveBeenCalledWith("pan_1", {
      since: "c1",
      waitSeconds: 25,
    });
    const body = JSON.parse(res.content[0]!.text);
    expect(body.next_cursor).toBe("c2");
    expect(body.events).toHaveLength(1);
  });

  it("send_to_pane forwards type/data/idempotency_key", async () => {
    const sendEvent = vi
      .fn()
      .mockResolvedValue({ event: { id: "ev_1" }, deduped: false });
    await tool("send_to_pane").handler(fakeClient({ sendEvent }), {
      pane_id: "pan_1",
      type: "progress",
      data: { pct: 50 },
      idempotency_key: "k1",
    });
    expect(sendEvent).toHaveBeenCalledWith("pan_1", {
      type: "progress",
      data: { pct: 50 },
      idempotencyKey: "k1",
    });
  });

  it("upsert_record passes record_key through and reports deduped", async () => {
    const upsertRecord = vi
      .fn()
      .mockResolvedValue({ record: { key: "t1" }, deduped: true });
    const res = await tool("upsert_record").handler(
      fakeClient({ upsertRecord }),
      {
        pane_id: "pan_1",
        collection: "todos",
        record_key: "t1",
        data: { text: "ship it" },
      },
    );
    expect(upsertRecord).toHaveBeenCalledWith("pan_1", "todos", {
      record_key: "t1",
      data: { text: "ship it" },
    });
    expect(JSON.parse(res.content[0]!.text).deduped).toBe(true);
  });

  it("delete_record returns { deleted: true } on success", async () => {
    const deleteRecord = vi.fn().mockResolvedValue(undefined);
    const res = await tool("delete_record").handler(
      fakeClient({ deleteRecord }),
      { pane_id: "pan_1", collection: "todos", record_key: "t1" },
    );
    expect(deleteRecord).toHaveBeenCalledWith("pan_1", "todos", "t1");
    expect(JSON.parse(res.content[0]!.text)).toEqual({ deleted: true });
  });

  it("surfaces a PaneApiError as a structured isError result with code + hint", async () => {
    const createPane = vi.fn().mockRejectedValue(
      new PaneApiError(
        422,
        "schema_validation_failed",
        "bad event type",
        {
          path: "type",
        },
        { hint: "declare the type in event_schema" },
      ),
    );
    const res = await tool("create_pane").handler(fakeClient({ createPane }), {
      name: "X",
      html: "<h1>x</h1>",
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.error).toBe("schema_validation_failed");
    expect(body.status).toBe(422);
    expect(body.hint).toBe("declare the type in event_schema");
  });

  it("surfaces a non-Pane error as an internal isError result", async () => {
    const getPane = vi.fn().mockRejectedValue(new Error("boom"));
    const res = await tool("get_pane_state").handler(fakeClient({ getPane }), {
      pane_id: "pan_1",
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.error).toBe("internal");
    expect(body.message).toBe("boom");
  });
});
