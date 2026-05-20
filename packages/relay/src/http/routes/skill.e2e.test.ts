// End-to-end coverage for GET /skills/pane/SKILL.md — the pane agent skill
// served verbatim by the relay. The route is auth-free and does not touch the
// database, so the setup is minimal.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";

let testDb: TestDb;
let prisma: PrismaClient;
let app: Hono;

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

describe("GET /skills/pane/SKILL.md", () => {
  it("serves the skill as markdown with a 200", async () => {
    const res = await app.fetch(new Request("http://t/skills/pane/SKILL.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
  });

  it("returns the actual skill content", async () => {
    const res = await app.fetch(new Request("http://t/skills/pane/SKILL.md"));
    const body = await res.text();
    // Frontmatter + heading from skills/pane/SKILL.md.
    expect(body).toContain("name: pane");
    expect(body).toContain("# pane");
  });

  it("marks the skill cacheable", async () => {
    const res = await app.fetch(new Request("http://t/skills/pane/SKILL.md"));
    expect(res.headers.get("cache-control")).toContain("max-age=");
  });

  it("404s on an unknown path under /skills", async () => {
    const res = await app.fetch(new Request("http://t/skills/pane/nope.md"));
    expect(res.status).toBe(404);
  });
});

// GET /skills/pane/SKILL.md/version — the version-only probe used by
// `pane skill version` for the agent's "is my local skill stale?" check.
describe("GET /skills/pane/SKILL.md/version", () => {
  it("returns the skill version as JSON", async () => {
    const res = await app.fetch(
      new Request("http://t/skills/pane/SKILL.md/version"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { version: string };
    // The shipped skill carries `<!-- pane skill vX.Y.Z -->`. We pin the
    // parsed shape, not a specific value — bumping the skill mustn't
    // break this test.
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is cacheable (the relay reads the skill once at boot)", async () => {
    const res = await app.fetch(
      new Request("http://t/skills/pane/SKILL.md/version"),
    );
    expect(res.headers.get("cache-control")).toContain("max-age=");
  });
});
