// End-to-end tests for POST /v1/surfaces under the reusable-templates model:
// the inline form (relay creates an anonymous template) and the reference form
// (instances an existing named template, optionally pinning a version).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { hashKey, keyPrefix } from "../../keys.js";
import { buildApp } from "../app.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(
    loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL: "http://localhost:3000",
    }),
    prisma,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedAgent(): Promise<string> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return apiKey;
}

const eventSchema = {
  events: {
    ping: { payload: { type: "object" }, emittedBy: ["page", "agent"] },
  },
};

function bearer(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function post(path: string, apiKey: string, body: unknown): Promise<Response> {
  // Auto-fill `title` on POST /v1/surfaces so the broad set of existing tests
  // (which predate the required-title rule from #158) doesn't need to repeat
  // it everywhere. Tests that specifically exercise the title rules pass an
  // explicit `title` (or `title: undefined` to drop it before serialization).
  let payload: unknown = body;
  if (path === "/v1/surfaces" && body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (!("title" in b)) payload = { ...b, title: "Test surface" };
  }
  return app.fetch(
    new Request(`http://t${path}`, {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify(payload),
    }),
  );
}

describe("POST /v1/surfaces — inline form", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("creates a surface and a transparent anonymous template", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { surface_id: string };
    expect(body.surface_id).toBeTruthy();

    // An anonymous template (name null) was created behind it.
    const templates = await prisma.template.findMany();
    expect(templates).toHaveLength(1);
    expect(templates[0]!.name).toBeNull();
    expect(templates[0]!.slug).toBeNull();
  });

  it("stores input_data on the surface", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
      input_data: { prTitle: "Fix the bug" },
    });
    expect(res.status).toBe(201);
    const { surface_id } = (await res.json()) as { surface_id: string };
    const get = await app.fetch(
      new Request(`http://t/v1/surfaces/${surface_id}`, {
        headers: bearer(apiKey),
      }),
    );
    const state = (await get.json()) as {
      input_data: Record<string, unknown> | null;
      template_version: number;
    };
    expect(state.input_data).toEqual({ prTitle: "Fix the bug" });
    expect(state.template_version).toBe(1);
  });

  it("rejects html-ref with 400", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-ref",
        source: "https://example.com/x",
        event_schema: eventSchema,
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/surfaces — reference form", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  async function createNamedArtifact(apiKey: string): Promise<string> {
    const res = await post("/v1/templates", apiKey, {
      name: "PR Review",
      slug: "pr-review",
      source: "<html>v1</html>",
      type: "html-inline",
      event_schema: eventSchema,
    });
    return ((await res.json()) as { template_id: string }).template_id;
  }

  it("instances an existing template by id", async () => {
    const apiKey = await seedAgent();
    const templateId = await createNamedArtifact(apiKey);
    const res = await post("/v1/surfaces", apiKey, {
      template: { id: templateId },
    });
    expect(res.status).toBe(201);
  });

  it("instances an existing template by slug", async () => {
    const apiKey = await seedAgent();
    await createNamedArtifact(apiKey);
    const res = await post("/v1/surfaces", apiKey, {
      template: { id: "pr-review" },
    });
    expect(res.status).toBe(201);
  });

  it("pins an explicit version", async () => {
    const apiKey = await seedAgent();
    const templateId = await createNamedArtifact(apiKey);
    await post(`/v1/templates/${templateId}/versions`, apiKey, {
      source: "<html>v2</html>",
      type: "html-inline",
      event_schema: eventSchema,
    });
    const res = await post("/v1/surfaces", apiKey, {
      template: { id: templateId, version: 1 },
    });
    expect(res.status).toBe(201);
    const { surface_id } = (await res.json()) as { surface_id: string };
    const get = await app.fetch(
      new Request(`http://t/v1/surfaces/${surface_id}`, {
        headers: bearer(apiKey),
      }),
    );
    expect(
      ((await get.json()) as { template_version: number }).template_version,
    ).toBe(1);
  });

  it("defaults to the latest version when none is given", async () => {
    const apiKey = await seedAgent();
    const templateId = await createNamedArtifact(apiKey);
    await post(`/v1/templates/${templateId}/versions`, apiKey, {
      source: "<html>v2</html>",
      type: "html-inline",
      event_schema: eventSchema,
    });
    const res = await post("/v1/surfaces", apiKey, {
      template: { id: templateId },
    });
    const { surface_id } = (await res.json()) as { surface_id: string };
    const get = await app.fetch(
      new Request(`http://t/v1/surfaces/${surface_id}`, {
        headers: bearer(apiKey),
      }),
    );
    expect(
      ((await get.json()) as { template_version: number }).template_version,
    ).toBe(2);
  });

  it("404s for an unknown template id", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: { id: "art_does_not_exist" },
    });
    expect(res.status).toBe(404);
  });

  it("404s for a missing version", async () => {
    const apiKey = await seedAgent();
    const templateId = await createNamedArtifact(apiKey);
    const res = await post("/v1/surfaces", apiKey, {
      template: { id: templateId, version: 99 },
    });
    expect(res.status).toBe(404);
  });

  it("404s for another agent's template", async () => {
    const owner = await seedAgent();
    const other = await seedAgent();
    const templateId = await createNamedArtifact(owner);
    const res = await post("/v1/surfaces", other, {
      template: { id: templateId },
    });
    expect(res.status).toBe(404);
  });

  it("bumps the template's last_used_at on surface create", async () => {
    const apiKey = await seedAgent();
    const templateId = await createNamedArtifact(apiKey);
    const before = await prisma.template.findUniqueOrThrow({
      where: { id: templateId },
    });
    expect(before.lastUsedAt).toBeNull();
    await post("/v1/surfaces", apiKey, { template: { id: templateId } });
    const after = await prisma.template.findUniqueOrThrow({
      where: { id: templateId },
    });
    expect(after.lastUsedAt).not.toBeNull();
  });
});

// Phase C — POST /v1/surfaces validates the surface's `input_data` against the
// pinned template version's `input_schema` before the surface row is created.
describe("POST /v1/surfaces — input_schema validation", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  const inputSchema = {
    type: "object",
    properties: {
      prTitle: { type: "string" },
      diffUrl: { type: "string" },
    },
    required: ["prTitle"],
    additionalProperties: false,
  };

  // Create a named template that declares an input_schema; returns its id.
  async function createArtifactWithInputSchema(
    apiKey: string,
  ): Promise<string> {
    const res = await post("/v1/templates", apiKey, {
      name: "PR Review",
      slug: "pr-review-c",
      source: "<html>v1</html>",
      type: "html-inline",
      event_schema: eventSchema,
      input_schema: inputSchema,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { template_id: string }).template_id;
  }

  it("accepts a surface whose input_data satisfies the input_schema", async () => {
    const apiKey = await seedAgent();
    const templateId = await createArtifactWithInputSchema(apiKey);
    const res = await post("/v1/surfaces", apiKey, {
      template: { id: templateId },
      input_data: { prTitle: "Fix the bug", diffUrl: "https://x/diff" },
    });
    expect(res.status).toBe(201);
  });

  it("rejects a surface whose input_data violates the input_schema", async () => {
    const apiKey = await seedAgent();
    const templateId = await createArtifactWithInputSchema(apiKey);
    const res = await post("/v1/surfaces", apiKey, {
      template: { id: templateId },
      input_data: { prTitle: 123 },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("input_schema_violation");
  });

  it("rejects a surface that omits input_data a required field needs", async () => {
    const apiKey = await seedAgent();
    const templateId = await createArtifactWithInputSchema(apiKey);
    const res = await post("/v1/surfaces", apiKey, {
      template: { id: templateId },
    });
    expect(res.status).toBe(422);
    // No surface row created — validation runs before the insert.
    expect(await prisma.surface.count()).toBe(0);
  });

  it("rejects an unexpected property when the schema forbids it", async () => {
    const apiKey = await seedAgent();
    const templateId = await createArtifactWithInputSchema(apiKey);
    const res = await post("/v1/surfaces", apiKey, {
      template: { id: templateId },
      input_data: { prTitle: "ok", bogus: true },
    });
    expect(res.status).toBe(422);
  });

  it("accepts a surface with no input_data when the version has no input_schema", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
    });
    expect(res.status).toBe(201);
  });

  it("accepts arbitrary input_data unvalidated when the version has no input_schema", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
      input_data: { anything: "goes", n: 7 },
    });
    expect(res.status).toBe(201);
  });

  it("rejects a malformed input_schema at template-write time, not surface-create", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/templates", apiKey, {
      name: "Bad",
      slug: "bad-schema",
      source: "<html></html>",
      type: "html-inline",
      event_schema: eventSchema,
      input_schema: { type: "not-a-real-type" },
    });
    expect(res.status).toBe(400);
  });
});

// Inline-form surfaces can ALSO carry an input_schema (#208). Pre-fix the
// relay's inline branch hardcoded `inputSchema: Prisma.JsonNull`, silently
// dropping any schema sent on the wire — which made attachment refs in
// `input_data` unreachable from the page because the participant attachment-
// download bridge walks input_data against the template version's
// inputSchema. These tests pin the new behaviour: the schema is persisted,
// it gates input_data validation, and it surfaces attachment-id sites to the
// reachability walker just like the named-template path.
describe("POST /v1/surfaces — inline form with input_schema (#208)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  const inputSchema = {
    type: "object",
    properties: {
      prTitle: { type: "string" },
      diffUrl: { type: "string" },
    },
    required: ["prTitle"],
    additionalProperties: false,
  };

  it("persists input_schema on the auto-created template version", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
        input_schema: inputSchema,
      },
      input_data: { prTitle: "Fix the bug", diffUrl: "https://x/diff" },
    });
    expect(res.status).toBe(201);

    // The auto-created template version carries the schema (pre-fix this was
    // Prisma.JsonNull regardless of what the request sent).
    const versions = await prisma.templateVersion.findMany();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.inputSchema).toEqual(inputSchema);
  });

  it("accepts inline surface whose input_data satisfies the schema", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
        input_schema: inputSchema,
      },
      input_data: { prTitle: "ok" },
    });
    expect(res.status).toBe(201);
  });

  it("rejects inline surface whose input_data violates the schema", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
        input_schema: inputSchema,
      },
      input_data: { prTitle: 123 }, // wrong type
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("input_schema_violation");
    // Validation runs before the insert; no surface row created.
    expect(await prisma.surface.count()).toBe(0);
  });

  it("rejects a missing required field in input_data", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
        input_schema: inputSchema,
      },
      // input_data omitted entirely → validated as {} → required prTitle fails
    });
    expect(res.status).toBe(422);
    expect(await prisma.surface.count()).toBe(0);
  });

  it("rejects a malformed inline input_schema at surface-create time", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
        input_schema: { type: "not-a-real-type" },
      },
    });
    expect(res.status).toBe(400);
    // No template + no surface leaked on the failed validation.
    expect(await prisma.template.count()).toBe(0);
    expect(await prisma.surface.count()).toBe(0);
  });

  it("input_schema is absent => no input contract (regression guard for the pre-fix default)", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
      input_data: { anything: "goes", n: 7 },
    });
    expect(res.status).toBe(201);
    const versions = await prisma.templateVersion.findMany();
    expect(versions[0]!.inputSchema).toBeNull();
  });
});

// View-only templates: an inline template created with NO event_schema declares
// an empty, strictly-enforced event vocabulary. The surface rejects every
// page/agent emit; system events keep flowing; input_schema is independent.
describe("POST /v1/surfaces — view-only template (no event_schema)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  // Create a view-only surface (inline form, omitting event_schema) and return
  // its id + the agent participant token.
  async function createViewOnlySession(
    apiKey: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ surfaceId: string; agentToken: string }> {
    const res = await post("/v1/surfaces", apiKey, {
      template: { type: "html-inline", source: "<html>report</html>" },
      ...extra,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      surface_id: string;
      tokens: { agent: string };
    };
    return { surfaceId: body.surface_id, agentToken: body.tokens.agent };
  }

  it("creates a surface when the inline template omits event_schema", async () => {
    const apiKey = await seedAgent();
    const { surfaceId } = await createViewOnlySession(apiKey);
    expect(surfaceId).toBeTruthy();
    // The pinned version persisted a null event_schema.
    const version = await prisma.templateVersion.findFirstOrThrow();
    expect(version.eventSchema).toBeNull();
  });

  it("rejects an agent emit on a view-only surface with 422 unknown_event_type", async () => {
    const apiKey = await seedAgent();
    const { surfaceId, agentToken } = await createViewOnlySession(apiKey);
    const res = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({ type: "anything.atall", data: {} }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown_event_type");
  });

  it("still emits system events on a view-only surface (Invariant 1)", async () => {
    const apiKey = await seedAgent();
    const { surfaceId, agentToken } = await createViewOnlySession(apiKey);
    // DELETE writes a system.surface.expired event directly.
    const del = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}`, {
        method: "DELETE",
        headers: bearer(apiKey),
      }),
    );
    expect(del.status).toBe(204);
    const get = await app.fetch(
      new Request(`http://t/v1/surfaces/${surfaceId}/events?since=0`, {
        headers: bearer(agentToken),
      }),
    );
    const body = (await get.json()) as { events: { type: string }[] };
    expect(body.events.some((e) => e.type === "system.surface.expired")).toBe(
      true,
    );
  });

  it("validates input_data against input_schema on a view-only template (Invariant 2)", async () => {
    const apiKey = await seedAgent();
    // A view-only template may still declare an input_schema (reusable report
    // template) — input validation is independent of the event schema.
    const created = await post("/v1/templates", apiKey, {
      name: "Sales Report",
      slug: "sales-report",
      source: "<html>report</html>",
      type: "html-inline",
      input_schema: {
        type: "object",
        properties: { quarter: { type: "string" } },
        required: ["quarter"],
      },
    });
    expect(created.status).toBe(201);
    const { template_id } = (await created.json()) as { template_id: string };

    // input_data that violates the input_schema is rejected.
    const bad = await post("/v1/surfaces", apiKey, {
      template: { id: template_id },
      input_data: { quarter: 4 },
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      "input_schema_violation",
    );

    // input_data that satisfies it is accepted.
    const ok = await post("/v1/surfaces", apiKey, {
      template: { id: template_id },
      input_data: { quarter: "Q4" },
    });
    expect(ok.status).toBe(201);
  });
});

// Title is required on every surface — the bridge shell renders it into
// <title>, so the relay refuses to mint a surface without one. The reference
// form has one ergonomic fallback: a named template's `name` is used when the
// caller omits `title`.
describe("POST /v1/surfaces — title", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  // postRaw bypasses the test-only auto-fill in `post(...)` so we can prove
  // the relay's behaviour when the wire body has no `title` field at all.
  function postRaw(
    path: string,
    apiKey: string,
    body: unknown,
  ): Promise<Response> {
    return app.fetch(
      new Request(`http://t${path}`, {
        method: "POST",
        headers: bearer(apiKey),
        body: JSON.stringify(body),
      }),
    );
  }

  async function createNamedArtifact(
    apiKey: string,
    name: string | null,
  ): Promise<string> {
    if (name === null) {
      // Anonymous template: name + slug null. The only way to create one is
      // via the inline-surface path that transparently spins one up. Re-use
      // that flow to get an template_id we can reference.
      const res = await post("/v1/surfaces", apiKey, {
        template: {
          type: "html-inline",
          source: "<html>x</html>",
          event_schema: eventSchema,
        },
      });
      const { surface_id } = (await res.json()) as { surface_id: string };
      const sess = await prisma.surface.findUnique({
        where: { id: surface_id },
        include: { templateVersion: true },
      });
      return sess!.templateVersion.templateId;
    }
    const res = await postRaw("/v1/templates", apiKey, {
      name,
      source: "<html>x</html>",
      type: "html-inline",
      event_schema: eventSchema,
    });
    return ((await res.json()) as { template_id: string }).template_id;
  }

  it("rejects the inline form with 400 when title is missing", async () => {
    const apiKey = await seedAgent();
    const res = await postRaw("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; hint?: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.hint).toMatch(/title/i);
  });

  it("accepts the inline form when title is provided and echoes it back", async () => {
    const apiKey = await seedAgent();
    const res = await postRaw("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
      title: "My pane",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { title: string; surface_id: string };
    expect(body.title).toBe("My pane");
    // GET also returns it.
    const get = await app.fetch(
      new Request(`http://t/v1/surfaces/${body.surface_id}`, {
        headers: bearer(apiKey),
      }),
    );
    expect(((await get.json()) as { title: string }).title).toBe("My pane");
  });

  it("falls back to Template.name when reference-form title is omitted", async () => {
    const apiKey = await seedAgent();
    await createNamedArtifact(apiKey, "PR Review");
    const res = await postRaw("/v1/surfaces", apiKey, {
      template: { id: "PR Review".toLowerCase() }, // resolve by id below
    });
    // The slug lookup needs the actual id since we didn't set a slug. Re-issue
    // with the id we just created.
    if (res.status === 404) {
      const head = await prisma.template.findFirst({
        where: { name: "PR Review" },
      });
      const res2 = await postRaw("/v1/surfaces", apiKey, {
        template: { id: head!.id },
      });
      expect(res2.status).toBe(201);
      const body = (await res2.json()) as { title: string };
      expect(body.title).toBe("PR Review");
      return;
    }
    expect(res.status).toBe(201);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("PR Review");
  });

  it("rejects reference form with 400 when template has no name AND no title given", async () => {
    const apiKey = await seedAgent();
    const anonId = await createNamedArtifact(apiKey, null);
    const res = await postRaw("/v1/surfaces", apiKey, {
      template: { id: anonId },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; hint?: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.hint).toMatch(/title/i);
  });

  it("prefers explicit title over Template.name", async () => {
    const apiKey = await seedAgent();
    await createNamedArtifact(apiKey, "Template Name");
    const head = await prisma.template.findFirst({
      where: { name: "Template Name" },
    });
    const res = await postRaw("/v1/surfaces", apiKey, {
      template: { id: head!.id },
      title: "Explicit title",
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { title: string }).title).toBe(
      "Explicit title",
    );
  });

  it("rejects a title with control characters (400)", async () => {
    const apiKey = await seedAgent();
    const res = await postRaw("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
      title: "line one\nline two",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
  });

  it("rejects a title longer than 80 chars (400)", async () => {
    const apiKey = await seedAgent();
    const res = await postRaw("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
      title: "x".repeat(81),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a whitespace-only title that trims to empty (400)", async () => {
    const apiKey = await seedAgent();
    const res = await postRaw("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
      title: "    ",
    });
    expect(res.status).toBe(400);
  });

  it("trims surrounding whitespace before storing", async () => {
    const apiKey = await seedAgent();
    const res = await postRaw("/v1/surfaces", apiKey, {
      template: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
      title: "  Padded  ",
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { title: string }).title).toBe("Padded");
  });
});
