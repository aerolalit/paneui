// End-to-end tests for the /v1/artifacts routes — reusable, versioned
// artifacts owned by an agent. Exercises create / version / patch / search /
// get-by-id / get-by-slug / get-version, ownership isolation, and the
// per-agent / per-artifact caps. DB engine follows DATABASE_URL.

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

const ARTIFACT_CAP = 5;
const VERSION_CAP = 3;

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
      MAX_ARTIFACTS_PER_AGENT: String(ARTIFACT_CAP),
      MAX_VERSIONS_PER_ARTIFACT: String(VERSION_CAP),
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
    "review.approved": {
      payload: { type: "object" },
      emittedBy: ["page", "agent"],
    },
  },
};

function bearer(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function req(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: bearer(apiKey),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function createArtifact(
  apiKey: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return req("POST", "/v1/artifacts", apiKey, {
    name: "PR Review",
    slug: "pr-review",
    description: "review a pull request",
    tags: ["review", "pr"],
    source: "<html><body>review</body></html>",
    type: "html-inline",
    event_schema: eventSchema,
    ...overrides,
  });
}

describe("/v1/artifacts", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("creates a named artifact and returns artifact_id + version 1", async () => {
    const apiKey = await seedAgent();
    const res = await createArtifact(apiKey);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      artifact_id: string;
      version: number;
    };
    expect(body.artifact_id).toBeTruthy();
    expect(body.version).toBe(1);
  });

  it("rejects html-ref artifacts with 400", async () => {
    const apiKey = await seedAgent();
    const res = await createArtifact(apiKey, {
      type: "html-ref",
      source: "https://example.com/page",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid input_schema with 400", async () => {
    const apiKey = await seedAgent();
    const res = await createArtifact(apiKey, {
      input_schema: { type: "not-a-real-type" },
    });
    expect(res.status).toBe(400);
  });

  it("appends a new version and bumps latest_version", async () => {
    const apiKey = await seedAgent();
    const created = (await (await createArtifact(apiKey)).json()) as {
      artifact_id: string;
    };
    const res = await req(
      "POST",
      `/v1/artifacts/${created.artifact_id}/versions`,
      apiKey,
      {
        source: "<html><body>v2</body></html>",
        type: "html-inline",
        event_schema: eventSchema,
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { version: number };
    expect(body.version).toBe(2);

    const get = await req(
      "GET",
      `/v1/artifacts/${created.artifact_id}`,
      apiKey,
    );
    const full = (await get.json()) as {
      latest_version: number;
      versions: { version: number }[];
    };
    expect(full.latest_version).toBe(2);
    expect(full.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("appends a version addressed by slug, not just id", async () => {
    const apiKey = await seedAgent();
    await createArtifact(apiKey, { slug: "by-slug" });
    const res = await req("POST", "/v1/artifacts/by-slug/versions", apiKey, {
      source: "<html><body>v2</body></html>",
      type: "html-inline",
      event_schema: eventSchema,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { version: number }).version).toBe(2);
  });

  it("patches head metadata addressed by slug", async () => {
    const apiKey = await seedAgent();
    await createArtifact(apiKey, { slug: "patch-by-slug" });
    const res = await req("PATCH", "/v1/artifacts/patch-by-slug", apiKey, {
      description: "patched via slug",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { description: string }).description).toBe(
      "patched via slug",
    );
  });

  it("patches head metadata", async () => {
    const apiKey = await seedAgent();
    const created = (await (await createArtifact(apiKey)).json()) as {
      artifact_id: string;
    };
    const res = await req(
      "PATCH",
      `/v1/artifacts/${created.artifact_id}`,
      apiKey,
      { name: "Renamed", description: "now updated" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; description: string };
    expect(body.name).toBe("Renamed");
    expect(body.description).toBe("now updated");
  });

  it("rejects a slug collision with 409", async () => {
    const apiKey = await seedAgent();
    await createArtifact(apiKey, { slug: "dup" });
    const res = await createArtifact(apiKey, { name: "Other", slug: "dup" });
    expect(res.status).toBe(409);
  });

  it("searches by q over name/description/tags", async () => {
    const apiKey = await seedAgent();
    await createArtifact(apiKey, { name: "PR Review", slug: "pr-review" });
    await createArtifact(apiKey, {
      name: "Survey Form",
      slug: "survey",
      description: "collect feedback",
      tags: ["survey"],
    });

    const all = await req("GET", "/v1/artifacts", apiKey);
    expect(
      ((await all.json()) as { artifacts: unknown[] }).artifacts,
    ).toHaveLength(2);

    const hit = await req("GET", "/v1/artifacts?q=feedback", apiKey);
    const hitBody = (await hit.json()) as {
      artifacts: { slug: string }[];
    };
    expect(hitBody.artifacts).toHaveLength(1);
    expect(hitBody.artifacts[0]!.slug).toBe("survey");
    // Lean response — no source blob.
    expect(hitBody.artifacts[0]).not.toHaveProperty("source");
  });

  it("gets an artifact by id and by slug", async () => {
    const apiKey = await seedAgent();
    const created = (await (await createArtifact(apiKey)).json()) as {
      artifact_id: string;
    };
    const byId = await req(
      "GET",
      `/v1/artifacts/${created.artifact_id}`,
      apiKey,
    );
    expect(byId.status).toBe(200);
    const bySlug = await req("GET", "/v1/artifacts/pr-review", apiKey);
    expect(bySlug.status).toBe(200);
    expect(((await bySlug.json()) as { id: string }).id).toBe(
      created.artifact_id,
    );
  });

  it("gets a specific version's full content", async () => {
    const apiKey = await seedAgent();
    const created = (await (await createArtifact(apiKey)).json()) as {
      artifact_id: string;
    };
    const res = await req(
      "GET",
      `/v1/artifacts/${created.artifact_id}/versions/1`,
      apiKey,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; source: string };
    expect(body.version).toBe(1);
    expect(body.source).toContain("review");
  });

  it("returns 404 for another agent's artifact", async () => {
    const owner = await seedAgent();
    const other = await seedAgent();
    const created = (await (await createArtifact(owner)).json()) as {
      artifact_id: string;
    };
    const res = await req("GET", `/v1/artifacts/${created.artifact_id}`, other);
    expect(res.status).toBe(404);

    const patch = await req(
      "PATCH",
      `/v1/artifacts/${created.artifact_id}`,
      other,
      { name: "hijack" },
    );
    expect(patch.status).toBe(404);
  });

  it("enforces MAX_ARTIFACTS_PER_AGENT", async () => {
    const apiKey = await seedAgent();
    for (let i = 0; i < ARTIFACT_CAP; i++) {
      const r = await createArtifact(apiKey, {
        name: `a${i}`,
        slug: `a${i}`,
      });
      expect(r.status).toBe(201);
    }
    const over = await createArtifact(apiKey, { name: "over", slug: "over" });
    expect(over.status).toBe(429);
  });

  it("enforces MAX_VERSIONS_PER_ARTIFACT", async () => {
    const apiKey = await seedAgent();
    const created = (await (await createArtifact(apiKey)).json()) as {
      artifact_id: string;
    };
    // v1 already exists; append up to the cap.
    for (let v = 2; v <= VERSION_CAP; v++) {
      const r = await req(
        "POST",
        `/v1/artifacts/${created.artifact_id}/versions`,
        apiKey,
        {
          source: "<html></html>",
          type: "html-inline",
          event_schema: eventSchema,
        },
      );
      expect(r.status).toBe(201);
    }
    const over = await req(
      "POST",
      `/v1/artifacts/${created.artifact_id}/versions`,
      apiKey,
      {
        source: "<html></html>",
        type: "html-inline",
        event_schema: eventSchema,
      },
    );
    expect(over.status).toBe(429);
  });
});
