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

/** The full tool set after the CLI-parity expansion. */
const EXPECTED_TOOLS = [
  // hot-path discrete
  "create_pane",
  "get_pane_state",
  "get_events",
  "send_to_pane",
  "update_pane",
  "upgrade_pane",
  "list_panes",
  "delete_pane",
  // record CRUD (discrete, hot-path)
  "list_records",
  "get_record",
  "upsert_record",
  "update_record",
  "delete_record",
  "delete_record_collection",
  // consolidated management
  "template",
  "template_records",
  "participant",
  "share",
  "attachments",
  "taste",
  "key",
  "trash",
  "feedback",
  "agent",
  // single-purpose
  "run_query",
  "get_skill",
];

describe("tool listing", () => {
  it("exposes exactly the expected tool set", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      EXPECTED_TOOLS.slice().sort(),
    );
  });

  it("has no duplicate tool names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("consolidated tools require an `action` field", () => {
    for (const name of [
      "template",
      "template_records",
      "participant",
      "share",
      "attachments",
      "taste",
      "key",
      "trash",
      "feedback",
      "agent",
    ]) {
      expect("action" in tool(name).inputSchema).toBe(true);
    }
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
  it("create_pane accepts the inline form (name + html)", () => {
    // name/html are schema-optional now (the template_id reference form omits
    // them); the inline-vs-reference requirement is enforced in the handler.
    const schema = z.object(tool("create_pane").inputSchema);
    expect(schema.safeParse({ name: "X", html: "<h1>hi</h1>" }).success).toBe(
      true,
    );
    expect(schema.safeParse({ template_id: "tpl_1" }).success).toBe(true);
  });

  it("create_pane handler rejects name-only (no html, no template_id)", async () => {
    const createPane = vi.fn();
    const res = await tool("create_pane").handler(fakeClient({ createPane }), {
      name: "X",
    });
    expect(res.isError).toBe(true);
    expect(createPane).not.toHaveBeenCalled();
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
    expect(deleteRecord).toHaveBeenCalledWith("pan_1", "todos", "t1", {});
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      deleted: true,
      key: "t1",
    });
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

// ---------------------------------------------------------------------------
// create_pane — template-reference form + extended fields
// ---------------------------------------------------------------------------

describe("create_pane forms", () => {
  it("uses the template reference form when template_id is given", async () => {
    const createPane = vi.fn().mockResolvedValue({
      pane_id: "pan_t",
      urls: { humans: ["https://r/s/x"], agent_stream: "ws" },
      title: "T",
      expires_at: "2026-01-01T00:00:00Z",
    });
    await tool("create_pane").handler(fakeClient({ createPane }), {
      template_id: "tpl_1",
      template_version: 3,
      participants: 2,
      tags: ["repo:pane"],
    });
    const req = createPane.mock.calls[0]![0];
    expect(req.template).toEqual({ id: "tpl_1", version: 3 });
    expect(req.participants).toEqual({ humans: 2 });
    expect(req.tags).toEqual(["repo:pane"]);
  });

  it("rejects passing both html and template_id", async () => {
    const createPane = vi.fn();
    const res = await tool("create_pane").handler(fakeClient({ createPane }), {
      html: "<h1>x</h1>",
      name: "X",
      template_id: "tpl_1",
    });
    expect(res.isError).toBe(true);
    expect(createPane).not.toHaveBeenCalled();
  });

  it("rejects neither html nor template_id", async () => {
    const createPane = vi.fn();
    const res = await tool("create_pane").handler(
      fakeClient({ createPane }),
      {},
    );
    expect(res.isError).toBe(true);
    expect(createPane).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// New hot-path discrete tools
// ---------------------------------------------------------------------------

describe("pane lifecycle tools", () => {
  it("update_pane maps ttl_seconds → ttl and rejects ttl+expires_at", async () => {
    const updatePane = vi.fn().mockResolvedValue({ pane_id: "p" });
    await tool("update_pane").handler(fakeClient({ updatePane }), {
      pane_id: "p",
      ttl_seconds: 600,
      title: "New",
    });
    expect(updatePane).toHaveBeenCalledWith("p", { ttl: 600, title: "New" });

    const res = await tool("update_pane").handler(fakeClient({ updatePane }), {
      pane_id: "p",
      ttl_seconds: 1,
      expires_at: "2026-01-01T00:00:00Z",
    });
    expect(res.isError).toBe(true);
  });

  it("update_pane clear_icon_emoji sends null", async () => {
    const updatePane = vi.fn().mockResolvedValue({ pane_id: "p" });
    await tool("update_pane").handler(fakeClient({ updatePane }), {
      pane_id: "p",
      clear_icon_emoji: true,
    });
    expect(updatePane).toHaveBeenCalledWith("p", { icon_emoji: null });
  });

  it("update_pane rejects an empty patch", async () => {
    const updatePane = vi.fn();
    const res = await tool("update_pane").handler(fakeClient({ updatePane }), {
      pane_id: "p",
    });
    expect(res.isError).toBe(true);
    expect(updatePane).not.toHaveBeenCalled();
  });

  it("upgrade_pane maps force → compat:force", async () => {
    const upgradePane = vi.fn().mockResolvedValue({ upgraded: true });
    await tool("upgrade_pane").handler(fakeClient({ upgradePane }), {
      pane_id: "p",
      template_version: 2,
      force: true,
    });
    expect(upgradePane).toHaveBeenCalledWith("p", {
      template_version: 2,
      compat: "force",
    });
  });

  it("list_panes forwards filters", async () => {
    const listPanes = vi
      .fn()
      .mockResolvedValue({ items: [], next_cursor: null });
    await tool("list_panes").handler(fakeClient({ listPanes }), {
      status: "all",
      limit: 10,
      template_id: "tpl_1",
    });
    expect(listPanes).toHaveBeenCalledWith({
      status: "all",
      limit: 10,
      template_id: "tpl_1",
    });
  });

  it("delete_pane returns { deleted: true }", async () => {
    const deletePane = vi.fn().mockResolvedValue(undefined);
    const res = await tool("delete_pane").handler(fakeClient({ deletePane }), {
      pane_id: "p",
    });
    expect(deletePane).toHaveBeenCalledWith("p");
    expect(JSON.parse(res.content[0]!.text).deleted).toBe(true);
  });

  it("get_record returns the row, errors when missing", async () => {
    const getRecord = vi.fn().mockResolvedValue({ key: "k", data: {} });
    const ok = await tool("get_record").handler(fakeClient({ getRecord }), {
      pane_id: "p",
      collection: "c",
      record_key: "k",
    });
    expect(JSON.parse(ok.content[0]!.text).record.key).toBe("k");

    const miss = await tool("get_record").handler(
      fakeClient({ getRecord: vi.fn().mockResolvedValue(null) }),
      { pane_id: "p", collection: "c", record_key: "nope" },
    );
    expect(miss.isError).toBe(true);
  });

  it("list_records filters tombstones unless include_tombstones", async () => {
    const rows = [
      { key: "a", deleted_at: null },
      { key: "b", deleted_at: "2026-01-01" },
    ];
    const listRecords = vi
      .fn()
      .mockResolvedValue({ records: rows, next_since: 5, has_more: false });
    const def = await tool("list_records").handler(
      fakeClient({ listRecords }),
      {
        pane_id: "p",
        collection: "c",
      },
    );
    expect(JSON.parse(def.content[0]!.text).records).toHaveLength(1);
    const all = await tool("list_records").handler(
      fakeClient({ listRecords }),
      {
        pane_id: "p",
        collection: "c",
        include_tombstones: true,
      },
    );
    expect(JSON.parse(all.content[0]!.text).records).toHaveLength(2);
  });

  it("delete_record_collection requires confirm:true", () => {
    const schema = z.object(
      tool("delete_record_collection").inputSchema as Record<
        string,
        z.ZodTypeAny
      >,
    );
    // confirm is required and must be literally true.
    expect(schema.safeParse({ pane_id: "p", collection: "c" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ pane_id: "p", collection: "c", confirm: false })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ pane_id: "p", collection: "c", confirm: true })
        .success,
    ).toBe(true);
  });

  it("delete_record_collection blocks the drop without confirm:true", async () => {
    const deleteRecordCollection = vi.fn().mockResolvedValue(undefined);
    const blocked = await tool("delete_record_collection").handler(
      fakeClient({ deleteRecordCollection }),
      { pane_id: "p", collection: "c" },
    );
    expect(blocked.isError).toBe(true);
    expect(deleteRecordCollection).not.toHaveBeenCalled();
  });

  it("delete_record_collection drops the collection via core with confirm:true", async () => {
    const deleteRecordCollection = vi.fn().mockResolvedValue(undefined);
    const res = await tool("delete_record_collection").handler(
      fakeClient({ deleteRecordCollection }),
      { pane_id: "p", collection: "c", confirm: true },
    );
    expect(deleteRecordCollection).toHaveBeenCalledWith("p", "c");
    const body = JSON.parse(res.content[0]!.text);
    expect(body).toMatchObject({ deleted: true, collection: "c" });
  });
});

// ---------------------------------------------------------------------------
// Consolidated tools — per-action coverage
// ---------------------------------------------------------------------------

describe("template tool actions", () => {
  it("create requires name + html", async () => {
    const createArtifact = vi.fn();
    const res = await tool("template").handler(fakeClient({ createArtifact }), {
      action: "create",
      name: "X",
    });
    expect(res.isError).toBe(true);
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it("create assembles the request", async () => {
    const createArtifact = vi
      .fn()
      .mockResolvedValue({ template_id: "tpl_1", version: 1 });
    await tool("template").handler(fakeClient({ createArtifact }), {
      action: "create",
      name: "Picker",
      html: "<div></div>",
      tags: ["a"],
      event_schema: { events: {} },
    });
    const req = createArtifact.mock.calls[0]![0];
    expect(req).toMatchObject({
      name: "Picker",
      type: "html-inline",
      source: "<div></div>",
      tags: ["a"],
      event_schema: { events: {} },
    });
  });

  it("delete requires confirm:true", async () => {
    const deleteArtifact = vi.fn().mockResolvedValue(undefined);
    const blocked = await tool("template").handler(
      fakeClient({ deleteArtifact }),
      { action: "delete", id: "tpl_1" },
    );
    expect(blocked.isError).toBe(true);
    expect(deleteArtifact).not.toHaveBeenCalled();

    await tool("template").handler(fakeClient({ deleteArtifact }), {
      action: "delete",
      id: "tpl_1",
      confirm: true,
    });
    expect(deleteArtifact).toHaveBeenCalledWith("tpl_1");
  });

  it("list calls searchArtifacts with no query", async () => {
    const searchArtifacts = vi.fn().mockResolvedValue([]);
    await tool("template").handler(fakeClient({ searchArtifacts }), {
      action: "list",
    });
    expect(searchArtifacts).toHaveBeenCalledWith();
  });

  it("set_icon needs exactly one of emoji/attachment/clear", async () => {
    const updateArtifact = vi.fn().mockResolvedValue({ id: "tpl_1" });
    const bad = await tool("template").handler(fakeClient({ updateArtifact }), {
      action: "set_icon",
      id: "tpl_1",
    });
    expect(bad.isError).toBe(true);

    await tool("template").handler(fakeClient({ updateArtifact }), {
      action: "set_icon",
      id: "tpl_1",
      clear: true,
    });
    expect(updateArtifact).toHaveBeenCalledWith("tpl_1", {
      icon_emoji: null,
      icon_attachment_id: null,
    });
  });
});

describe("template_records tool", () => {
  it("upsert requires data", async () => {
    const upsertTemplateRecord = vi.fn();
    const res = await tool("template_records").handler(
      fakeClient({ upsertTemplateRecord }),
      { action: "upsert", template_id: "tpl_1", collection: "c" },
    );
    expect(res.isError).toBe(true);
    expect(upsertTemplateRecord).not.toHaveBeenCalled();
  });

  it("delete_collection requires confirm", async () => {
    const deleteTemplateRecordCollection = vi.fn().mockResolvedValue(undefined);
    const blocked = await tool("template_records").handler(
      fakeClient({ deleteTemplateRecordCollection }),
      { action: "delete_collection", template_id: "tpl_1", collection: "c" },
    );
    expect(blocked.isError).toBe(true);
    await tool("template_records").handler(
      fakeClient({ deleteTemplateRecordCollection }),
      {
        action: "delete_collection",
        template_id: "tpl_1",
        collection: "c",
        confirm: true,
      },
    );
    expect(deleteTemplateRecordCollection).toHaveBeenCalledWith("tpl_1", "c");
  });
});

describe("participant tool", () => {
  it("new mints a participant", async () => {
    const mintParticipant = vi.fn().mockResolvedValue({ url: "https://r/s/x" });
    await tool("participant").handler(fakeClient({ mintParticipant }), {
      action: "new",
      pane_id: "p",
    });
    expect(mintParticipant).toHaveBeenCalledWith("p");
  });

  it("revoke requires participant_id", async () => {
    const revokeParticipant = vi.fn();
    const res = await tool("participant").handler(
      fakeClient({ revokeParticipant }),
      { action: "revoke", pane_id: "p" },
    );
    expect(res.isError).toBe(true);
    expect(revokeParticipant).not.toHaveBeenCalled();
  });
});

describe("share tool", () => {
  it("invite forwards email + role", async () => {
    const createGrant = vi.fn().mockResolvedValue({ id: "g1" });
    await tool("share").handler(fakeClient({ createGrant }), {
      action: "invite",
      pane_id: "p",
      email: "a@b.c",
      role: "viewer",
    });
    expect(createGrant).toHaveBeenCalledWith("p", {
      email: "a@b.c",
      role: "viewer",
    });
  });

  it("set_access forwards the mode", async () => {
    const setPaneVisibility = vi
      .fn()
      .mockResolvedValue({ access_mode: "public" });
    await tool("share").handler(fakeClient({ setPaneVisibility }), {
      action: "set_access",
      pane_id: "p",
      access_mode: "public",
    });
    expect(setPaneVisibility).toHaveBeenCalledWith("p", "public");
  });
});

describe("attachments tool", () => {
  it("upload rejects scope=pane without pane_id", async () => {
    const uploadBlob = vi.fn();
    const res = await tool("attachments").handler(fakeClient({ uploadBlob }), {
      action: "upload",
      file_path: "/tmp/whatever",
      scope: "pane",
    });
    expect(res.isError).toBe(true);
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it("download returns base64 when no out_path", async () => {
    const bytes = new TextEncoder().encode("hello");
    const downloadBlob = vi.fn().mockResolvedValue(bytes.buffer);
    const res = await tool("attachments").handler(
      fakeClient({ downloadBlob }),
      {
        action: "download",
        attachment_id: "att_1",
      },
    );
    const body = JSON.parse(res.content[0]!.text);
    expect(Buffer.from(body.base64, "base64").toString("utf8")).toBe("hello");
  });

  it("mint_token forwards ttl + once", async () => {
    const mintBlobToken = vi.fn().mockResolvedValue({ token: "t" });
    await tool("attachments").handler(fakeClient({ mintBlobToken }), {
      action: "mint_token",
      attachment_id: "att_1",
      ttl_seconds: 60,
      once: true,
    });
    expect(mintBlobToken).toHaveBeenCalledWith("att_1", {
      ttlSeconds: 60,
      once: true,
    });
  });
});

describe("taste / key / trash / feedback / agent tools", () => {
  it("taste set rejects empty notes", async () => {
    const setTaste = vi.fn();
    const res = await tool("taste").handler(fakeClient({ setTaste }), {
      action: "set",
      taste: "   ",
    });
    expect(res.isError).toBe(true);
    expect(setTaste).not.toHaveBeenCalled();
  });

  it("taste clear returns cleared", async () => {
    const clearTaste = vi.fn().mockResolvedValue(undefined);
    const res = await tool("taste").handler(fakeClient({ clearTaste }), {
      action: "clear",
    });
    expect(JSON.parse(res.content[0]!.text).cleared).toBe(true);
  });

  it("key revoke requires confirm", async () => {
    const listKeys = vi.fn().mockResolvedValue({ agent_id: "ag_1" });
    const revokeKey = vi.fn().mockResolvedValue(undefined);
    const blocked = await tool("key").handler(
      fakeClient({ listKeys, revokeKey }),
      { action: "revoke" },
    );
    expect(blocked.isError).toBe(true);
    expect(revokeKey).not.toHaveBeenCalled();

    await tool("key").handler(fakeClient({ listKeys, revokeKey }), {
      action: "revoke",
      confirm: true,
    });
    expect(revokeKey).toHaveBeenCalledWith("ag_1");
  });

  it("trash purge_template maps to permanentDeleteTemplate", async () => {
    const permanentDeleteTemplate = vi.fn().mockResolvedValue(undefined);
    await tool("trash").handler(fakeClient({ permanentDeleteTemplate }), {
      action: "purge_template",
      id: "tpl_1",
    });
    expect(permanentDeleteTemplate).toHaveBeenCalledWith("tpl_1");
  });

  it("feedback create requires type + message", async () => {
    const submitFeedback = vi.fn();
    const res = await tool("feedback").handler(fakeClient({ submitFeedback }), {
      action: "create",
      type: "bug",
    });
    expect(res.isError).toBe(true);
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("agent whoami needs no client and no network", async () => {
    const res = await tool("agent").handler(fakeClient({}), {
      action: "whoami",
    });
    const body = JSON.parse(res.content[0]!.text);
    expect(typeof body.url).toBe("string");
    expect("api_key_present" in body).toBe(true);
  });

  it("agent claim forwards the code", async () => {
    const claimAgent = vi
      .fn()
      .mockResolvedValue({ ok: true, owner_human_id: "h1" });
    await tool("agent").handler(fakeClient({ claimAgent }), {
      action: "claim",
      code: "abc123",
    });
    expect(claimAgent).toHaveBeenCalledWith("abc123");
  });
});

describe("run_query tool", () => {
  const result = {
    columns: ["title", "n"],
    rows: [
      ["A", 1],
      ["B", 2],
    ],
    truncated: false,
    scope: { kind: "agent", pane_count: 3 },
    elapsed_ms: 5,
  };

  it("returns json by default", async () => {
    const query = vi.fn().mockResolvedValue(result);
    const res = await tool("run_query").handler(fakeClient({ query }), {
      sql: "SELECT 1",
    });
    expect(query).toHaveBeenCalledWith("SELECT 1", {});
    expect(JSON.parse(res.content[0]!.text).columns).toEqual(["title", "n"]);
  });

  it("renders csv as text with a header row", async () => {
    const query = vi.fn().mockResolvedValue(result);
    const res = await tool("run_query").handler(fakeClient({ query }), {
      sql: "SELECT 1",
      format: "csv",
    });
    expect(res.content[0]!.text.split("\n")[0]).toBe("title,n");
  });

  it("forwards pane_id scoping", async () => {
    const query = vi.fn().mockResolvedValue(result);
    await tool("run_query").handler(fakeClient({ query }), {
      sql: "SELECT 1",
      pane_id: "pan_x",
    });
    expect(query).toHaveBeenCalledWith("SELECT 1", { paneId: "pan_x" });
  });
});
