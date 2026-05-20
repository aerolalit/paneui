// End-to-end tests for POST /v1/sessions under the reusable-artifacts model:
// the inline form (relay creates an anonymous artifact) and the reference form
// (instances an existing named artifact, optionally pinning a version).

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
let closeDb: () => Promise<void>;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  ({ prisma, close: closeDb } = createPrismaClient(testDb.dbUrl));
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
  await closeDb();
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
  return app.fetch(
    new Request(`http://t${path}`, {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /v1/sessions — inline form", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("creates a session and a transparent anonymous artifact", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/sessions", apiKey, {
      artifact: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session_id: string };
    expect(body.session_id).toBeTruthy();

    // An anonymous artifact (name null) was created behind it.
    const artifacts = await prisma.artifact.findMany();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.name).toBeNull();
    expect(artifacts[0]!.slug).toBeNull();
  });

  it("stores input_data on the session", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/sessions", apiKey, {
      artifact: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
      input_data: { prTitle: "Fix the bug" },
    });
    expect(res.status).toBe(201);
    const { session_id } = (await res.json()) as { session_id: string };
    const get = await app.fetch(
      new Request(`http://t/v1/sessions/${session_id}`, {
        headers: bearer(apiKey),
      }),
    );
    const state = (await get.json()) as {
      input_data: Record<string, unknown> | null;
      artifact_version: number;
    };
    expect(state.input_data).toEqual({ prTitle: "Fix the bug" });
    expect(state.artifact_version).toBe(1);
  });

  it("rejects html-ref with 400", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/sessions", apiKey, {
      artifact: {
        type: "html-ref",
        source: "https://example.com/x",
        event_schema: eventSchema,
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/sessions — reference form", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  async function createNamedArtifact(apiKey: string): Promise<string> {
    const res = await post("/v1/artifacts", apiKey, {
      name: "PR Review",
      slug: "pr-review",
      source: "<html>v1</html>",
      type: "html-inline",
      event_schema: eventSchema,
    });
    return ((await res.json()) as { artifact_id: string }).artifact_id;
  }

  it("instances an existing artifact by id", async () => {
    const apiKey = await seedAgent();
    const artifactId = await createNamedArtifact(apiKey);
    const res = await post("/v1/sessions", apiKey, {
      artifact: { id: artifactId },
    });
    expect(res.status).toBe(201);
  });

  it("instances an existing artifact by slug", async () => {
    const apiKey = await seedAgent();
    await createNamedArtifact(apiKey);
    const res = await post("/v1/sessions", apiKey, {
      artifact: { id: "pr-review" },
    });
    expect(res.status).toBe(201);
  });

  it("pins an explicit version", async () => {
    const apiKey = await seedAgent();
    const artifactId = await createNamedArtifact(apiKey);
    await post(`/v1/artifacts/${artifactId}/versions`, apiKey, {
      source: "<html>v2</html>",
      type: "html-inline",
      event_schema: eventSchema,
    });
    const res = await post("/v1/sessions", apiKey, {
      artifact: { id: artifactId, version: 1 },
    });
    expect(res.status).toBe(201);
    const { session_id } = (await res.json()) as { session_id: string };
    const get = await app.fetch(
      new Request(`http://t/v1/sessions/${session_id}`, {
        headers: bearer(apiKey),
      }),
    );
    expect(
      ((await get.json()) as { artifact_version: number }).artifact_version,
    ).toBe(1);
  });

  it("defaults to the latest version when none is given", async () => {
    const apiKey = await seedAgent();
    const artifactId = await createNamedArtifact(apiKey);
    await post(`/v1/artifacts/${artifactId}/versions`, apiKey, {
      source: "<html>v2</html>",
      type: "html-inline",
      event_schema: eventSchema,
    });
    const res = await post("/v1/sessions", apiKey, {
      artifact: { id: artifactId },
    });
    const { session_id } = (await res.json()) as { session_id: string };
    const get = await app.fetch(
      new Request(`http://t/v1/sessions/${session_id}`, {
        headers: bearer(apiKey),
      }),
    );
    expect(
      ((await get.json()) as { artifact_version: number }).artifact_version,
    ).toBe(2);
  });

  it("404s for an unknown artifact id", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/sessions", apiKey, {
      artifact: { id: "art_does_not_exist" },
    });
    expect(res.status).toBe(404);
  });

  it("404s for a missing version", async () => {
    const apiKey = await seedAgent();
    const artifactId = await createNamedArtifact(apiKey);
    const res = await post("/v1/sessions", apiKey, {
      artifact: { id: artifactId, version: 99 },
    });
    expect(res.status).toBe(404);
  });

  it("404s for another agent's artifact", async () => {
    const owner = await seedAgent();
    const other = await seedAgent();
    const artifactId = await createNamedArtifact(owner);
    const res = await post("/v1/sessions", other, {
      artifact: { id: artifactId },
    });
    expect(res.status).toBe(404);
  });

  it("bumps the artifact's last_used_at on session create", async () => {
    const apiKey = await seedAgent();
    const artifactId = await createNamedArtifact(apiKey);
    const before = await prisma.artifact.findUniqueOrThrow({
      where: { id: artifactId },
    });
    expect(before.lastUsedAt).toBeNull();
    await post("/v1/sessions", apiKey, { artifact: { id: artifactId } });
    const after = await prisma.artifact.findUniqueOrThrow({
      where: { id: artifactId },
    });
    expect(after.lastUsedAt).not.toBeNull();
  });
});

// Phase C — POST /v1/sessions validates the session's `input_data` against the
// pinned artifact version's `input_schema` before the session row is created.
describe("POST /v1/sessions — input_schema validation", () => {
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

  // Create a named artifact that declares an input_schema; returns its id.
  async function createArtifactWithInputSchema(
    apiKey: string,
  ): Promise<string> {
    const res = await post("/v1/artifacts", apiKey, {
      name: "PR Review",
      slug: "pr-review-c",
      source: "<html>v1</html>",
      type: "html-inline",
      event_schema: eventSchema,
      input_schema: inputSchema,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { artifact_id: string }).artifact_id;
  }

  it("accepts a session whose input_data satisfies the input_schema", async () => {
    const apiKey = await seedAgent();
    const artifactId = await createArtifactWithInputSchema(apiKey);
    const res = await post("/v1/sessions", apiKey, {
      artifact: { id: artifactId },
      input_data: { prTitle: "Fix the bug", diffUrl: "https://x/diff" },
    });
    expect(res.status).toBe(201);
  });

  it("rejects a session whose input_data violates the input_schema", async () => {
    const apiKey = await seedAgent();
    const artifactId = await createArtifactWithInputSchema(apiKey);
    const res = await post("/v1/sessions", apiKey, {
      artifact: { id: artifactId },
      input_data: { prTitle: 123 },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("input_schema_violation");
  });

  it("rejects a session that omits input_data a required field needs", async () => {
    const apiKey = await seedAgent();
    const artifactId = await createArtifactWithInputSchema(apiKey);
    const res = await post("/v1/sessions", apiKey, {
      artifact: { id: artifactId },
    });
    expect(res.status).toBe(422);
    // No session row created — validation runs before the insert.
    expect(await prisma.session.count()).toBe(0);
  });

  it("rejects an unexpected property when the schema forbids it", async () => {
    const apiKey = await seedAgent();
    const artifactId = await createArtifactWithInputSchema(apiKey);
    const res = await post("/v1/sessions", apiKey, {
      artifact: { id: artifactId },
      input_data: { prTitle: "ok", bogus: true },
    });
    expect(res.status).toBe(422);
  });

  it("accepts a session with no input_data when the version has no input_schema", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/sessions", apiKey, {
      artifact: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
    });
    expect(res.status).toBe(201);
  });

  it("accepts arbitrary input_data unvalidated when the version has no input_schema", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/sessions", apiKey, {
      artifact: {
        type: "html-inline",
        source: "<html></html>",
        event_schema: eventSchema,
      },
      input_data: { anything: "goes", n: 7 },
    });
    expect(res.status).toBe(201);
  });

  it("rejects a malformed input_schema at artifact-write time, not session-create", async () => {
    const apiKey = await seedAgent();
    const res = await post("/v1/artifacts", apiKey, {
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

// View-only artifacts: an inline artifact created with NO event_schema declares
// an empty, strictly-enforced event vocabulary. The session rejects every
// page/agent emit; system events keep flowing; input_schema is independent.
describe("POST /v1/sessions — view-only artifact (no event_schema)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  // Create a view-only session (inline form, omitting event_schema) and return
  // its id + the agent participant token.
  async function createViewOnlySession(
    apiKey: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ sessionId: string; agentToken: string }> {
    const res = await post("/v1/sessions", apiKey, {
      artifact: { type: "html-inline", source: "<html>report</html>" },
      ...extra,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      session_id: string;
      tokens: { agent: string };
    };
    return { sessionId: body.session_id, agentToken: body.tokens.agent };
  }

  it("creates a session when the inline artifact omits event_schema", async () => {
    const apiKey = await seedAgent();
    const { sessionId } = await createViewOnlySession(apiKey);
    expect(sessionId).toBeTruthy();
    // The pinned version persisted a null event_schema.
    const version = await prisma.artifactVersion.findFirstOrThrow();
    expect(version.eventSchema).toBeNull();
  });

  it("rejects an agent emit on a view-only session with 422 unknown_event_type", async () => {
    const apiKey = await seedAgent();
    const { sessionId, agentToken } = await createViewOnlySession(apiKey);
    const res = await app.fetch(
      new Request(`http://t/v1/sessions/${sessionId}/events`, {
        method: "POST",
        headers: bearer(agentToken),
        body: JSON.stringify({ type: "anything.atall", data: {} }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown_event_type");
  });

  it("still emits system events on a view-only session (Invariant 1)", async () => {
    const apiKey = await seedAgent();
    const { sessionId, agentToken } = await createViewOnlySession(apiKey);
    // DELETE writes a system.session.expired event directly.
    const del = await app.fetch(
      new Request(`http://t/v1/sessions/${sessionId}`, {
        method: "DELETE",
        headers: bearer(apiKey),
      }),
    );
    expect(del.status).toBe(204);
    const get = await app.fetch(
      new Request(`http://t/v1/sessions/${sessionId}/events?since=0`, {
        headers: bearer(agentToken),
      }),
    );
    const body = (await get.json()) as { events: { type: string }[] };
    expect(body.events.some((e) => e.type === "system.session.expired")).toBe(
      true,
    );
  });

  it("validates input_data against input_schema on a view-only artifact (Invariant 2)", async () => {
    const apiKey = await seedAgent();
    // A view-only artifact may still declare an input_schema (reusable report
    // template) — input validation is independent of the event schema.
    const created = await post("/v1/artifacts", apiKey, {
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
    const { artifact_id } = (await created.json()) as { artifact_id: string };

    // input_data that violates the input_schema is rejected.
    const bad = await post("/v1/sessions", apiKey, {
      artifact: { id: artifact_id },
      input_data: { quarter: 4 },
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      "input_schema_violation",
    );

    // input_data that satisfies it is accepted.
    const ok = await post("/v1/sessions", apiKey, {
      artifact: { id: artifact_id },
      input_data: { quarter: "Q4" },
    });
    expect(ok.status).toBe(201);
  });
});
