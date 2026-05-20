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

  // View-only artifact: created with no event_schema. The version persists a
  // null event_schema and GET serializes it as `event_schema: null`.
  it("creates a view-only artifact when event_schema is omitted", async () => {
    const apiKey = await seedAgent();
    // Build the body directly — createArtifact() always spreads in an
    // event_schema, and a spread cannot remove the key.
    const res = await req("POST", "/v1/artifacts", apiKey, {
      name: "Sales Dashboard",
      slug: "sales-dashboard",
      source: "<html><body>dashboard</body></html>",
      type: "html-inline",
    });
    expect(res.status).toBe(201);
    const { artifact_id } = (await res.json()) as { artifact_id: string };

    const get = await req("GET", `/v1/artifacts/${artifact_id}`, apiKey);
    const full = (await get.json()) as {
      versions: { event_schema: unknown }[];
    };
    expect(full.versions[0]!.event_schema).toBeNull();

    // The single-version endpoint serializes it as null too.
    const ver = await req(
      "GET",
      `/v1/artifacts/${artifact_id}/versions/1`,
      apiKey,
    );
    expect(((await ver.json()) as { event_schema: unknown }).event_schema).toBe(
      null,
    );
  });

  it("appends a view-only version when event_schema is omitted", async () => {
    const apiKey = await seedAgent();
    const created = (await (await createArtifact(apiKey)).json()) as {
      artifact_id: string;
    };
    const res = await req(
      "POST",
      `/v1/artifacts/${created.artifact_id}/versions`,
      apiKey,
      {
        source: "<html><body>view-only v2</body></html>",
        type: "html-inline",
      },
    );
    expect(res.status).toBe(201);
    const ver = await req(
      "GET",
      `/v1/artifacts/${created.artifact_id}/versions/2`,
      apiKey,
    );
    expect(((await ver.json()) as { event_schema: unknown }).event_schema).toBe(
      null,
    );
  });

  it("still rejects a present-but-malformed event_schema with 400", async () => {
    const apiKey = await seedAgent();
    // An absent schema is fine (view-only); a present, malformed one is not.
    const res = await createArtifact(apiKey, {
      event_schema: { events: {} },
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

// DELETE /v1/artifacts/:id — strict cascade: refuse if any session refs it.
describe("DELETE /v1/artifacts/:id (#137)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("deletes an artifact that has no referencing session (204)", async () => {
    const apiKey = await seedAgent();
    const created = (await (await createArtifact(apiKey)).json()) as {
      artifact_id: string;
    };

    const del = await req(
      "DELETE",
      `/v1/artifacts/${created.artifact_id}`,
      apiKey,
    );
    expect(del.status).toBe(204);

    // Subsequent GET returns 404 artifact_not_found, confirming the row is
    // gone (and via Prisma's onDelete:Cascade, its ArtifactVersion rows
    // too — see schema.prisma).
    const after = await req(
      "GET",
      `/v1/artifacts/${created.artifact_id}`,
      apiKey,
    );
    expect(after.status).toBe(404);
    const body = (await after.json()) as { error: { code: string } };
    expect(body.error.code).toBe("artifact_not_found");
  });

  it("also accepts a slug", async () => {
    const apiKey = await seedAgent();
    await createArtifact(apiKey);
    const del = await req("DELETE", "/v1/artifacts/pr-review", apiKey);
    expect(del.status).toBe(204);
  });

  it("returns 404 artifact_not_found on the second delete (not idempotent at the row level)", async () => {
    // We deliberately DO NOT make this 204-on-already-gone like
    // DELETE /v1/sessions, because the resource state semantics differ:
    // a session is a stateful row that can transition to 'closed' (still
    // present), whereas an artifact is fully removed. The second DELETE
    // can't tell "you already deleted it" from "you sent the wrong id"
    // — surface 404 either way and let the caller decide.
    const apiKey = await seedAgent();
    const created = (await (await createArtifact(apiKey)).json()) as {
      artifact_id: string;
    };
    expect(
      (await req("DELETE", `/v1/artifacts/${created.artifact_id}`, apiKey))
        .status,
    ).toBe(204);
    const second = await req(
      "DELETE",
      `/v1/artifacts/${created.artifact_id}`,
      apiKey,
    );
    expect(second.status).toBe(404);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("artifact_not_found");
  });

  it("refuses with 409 conflict when a session still references the artifact", async () => {
    // Strict-cascade behaviour: any session (open OR closed) referencing
    // a version blocks deletion. The error envelope carries a count and a
    // hint telling the caller what to do.
    const apiKey = await seedAgent();
    const created = (await (await createArtifact(apiKey)).json()) as {
      artifact_id: string;
    };
    const sessRes = await req("POST", "/v1/sessions", apiKey, {
      artifact: { id: created.artifact_id },
    });
    expect(sessRes.status).toBe(201);

    const del = await req(
      "DELETE",
      `/v1/artifacts/${created.artifact_id}`,
      apiKey,
    );
    expect(del.status).toBe(409);
    const body = (await del.json()) as {
      error: { code: string; message: string; hint?: string };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toMatch(/1 referencing session/);
    // The hint points at the recovery action.
    expect(body.error.hint).toMatch(/pane delete/);
  });

  it("refuses with 409 even after the referencing session is CLOSED", async () => {
    // 'pane delete <session>' marks the session status=closed but the row
    // (and its FK to artifact_version_id) stays. Strict-cascade still
    // refuses; the reporter's "stale test artifacts" complaint is only
    // partially addressed until session rows are actually dropped, but
    // that's a separate PR (see #137 follow-up).
    const apiKey = await seedAgent();
    const created = (await (await createArtifact(apiKey)).json()) as {
      artifact_id: string;
    };
    const sessRes = await req("POST", "/v1/sessions", apiKey, {
      artifact: { id: created.artifact_id },
    });
    const sess = (await sessRes.json()) as { session_id: string };
    expect(
      (await req("DELETE", `/v1/sessions/${sess.session_id}`, apiKey)).status,
    ).toBe(204);

    const del = await req(
      "DELETE",
      `/v1/artifacts/${created.artifact_id}`,
      apiKey,
    );
    expect(del.status).toBe(409);
  });

  it("404 artifact_not_found for an unknown id", async () => {
    const apiKey = await seedAgent();
    const del = await req("DELETE", "/v1/artifacts/art_bogus", apiKey);
    expect(del.status).toBe(404);
  });

  it("404 (not 403) when the artifact belongs to a different agent", async () => {
    // Ownership leak: distinguishing "not yours" from "doesn't exist"
    // would tell a probing caller which slugs exist. Treat both as 404
    // artifact_not_found — same pattern as sessionNotFound.
    const ownerKey = await seedAgent();
    const intruderKey = await seedAgent();
    const created = (await (await createArtifact(ownerKey)).json()) as {
      artifact_id: string;
    };
    const del = await req(
      "DELETE",
      `/v1/artifacts/${created.artifact_id}`,
      intruderKey,
    );
    expect(del.status).toBe(404);
    const body = (await del.json()) as { error: { code: string } };
    expect(body.error.code).toBe("artifact_not_found");
  });
});
