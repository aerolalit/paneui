// Integration test for writeEvent. Runs against whatever engine DATABASE_URL
// points at (sqlite file or postgres) — the CI matrix exercises both.
//
// We exercise the full pipeline (validate -> insert-or-dedupe -> publish ->
// webhook fire) end-to-end because the previous "unit test the leaves" approach
// missed a TOCTOU race between findUnique and create that survived two PR
// review passes. Concurrent dedupe is the centrepiece of the suite.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Author } from "../types.js";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { seedSessionRow } from "../test-helpers/seed.js";
import { createPrismaClient } from "../db.js";
import { loadConfig, type Config } from "../config.js";
import { encryptSecret, _resetKeyCacheForTests } from "../crypto.js";
import {
  writeEvent,
  type SurfaceWithArtifactVersion,
  type WriteEventInput,
  type WriteEventResult,
} from "./events.js";

let testDb: TestDb;
let prisma: PrismaClient;
let config: Config;

// Thin wrapper that binds writeEvent to the injected { prisma, config } deps so
// the individual test bodies stay focused on surface/author/input.
function we(
  surface: SurfaceWithArtifactVersion,
  author: Author,
  input: WriteEventInput,
): Promise<WriteEventResult> {
  return writeEvent({ prisma, config }, surface, author, input);
}

// Re-read a surface with its template version eagerly included — used after a
// raw update to hand writeEvent a fresh SurfaceWithArtifactVersion.
function reloadSession(id: string): Promise<SurfaceWithArtifactVersion> {
  return prisma.surface.findUniqueOrThrow({
    where: { id },
    include: { templateVersion: true },
  });
}

// Replace the pinned template version's event schema in place. The relay never
// mutates a version's content, but a test that needs a different vocabulary
// can do so directly against the row.
async function overrideEventSchema(
  surface: SurfaceWithArtifactVersion,
  eventSchema: object,
): Promise<SurfaceWithArtifactVersion> {
  await prisma.templateVersion.update({
    where: { id: surface.templateVersionId },
    data: { eventSchema },
  });
  return reloadSession(surface.id);
}

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  _resetKeyCacheForTests();

  prisma = createPrismaClient(testDb.dbUrl);
  config = loadConfig({ ...process.env, DATABASE_URL: testDb.dbUrl });
  await testDb.applyMigration(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

interface SeedOptions {
  status?: string;
  expiresInMs?: number;
  withCallback?: boolean;
  callbackSecret?: string;
  callbackUrl?: string;
  callbackFilter?: string[];
}

async function seedSession(
  opts: SeedOptions = {},
): Promise<{ surface: SurfaceWithArtifactVersion; agentId: string }> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
    },
  });
  const { surfaceId } = await seedSessionRow(prisma, {
    agentId: agent.id,
    eventSchema: {
      events: {
        "review.commentAdded": {
          payload: {
            type: "object",
            properties: { body: { type: "string" } },
            required: ["body"],
            additionalProperties: false,
          },
          emittedBy: ["page", "agent"],
        },
      },
    },
    status: (opts.status as "open" | "closed" | undefined) ?? "open",
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)),
    callbackUrl: opts.withCallback
      ? (opts.callbackUrl ?? "https://example.com/webhook")
      : null,
    callbackSecretEnc: opts.withCallback
      ? encryptSecret(
          opts.callbackSecret ?? "whsec_" + randomBytes(8).toString("hex"),
        )
      : null,
    callbackFilter: opts.withCallback
      ? (opts.callbackFilter ?? ["review.*"])
      : null,
  });
  const surface = await reloadSession(surfaceId);
  return { surface, agentId: agent.id };
}

const agentAuthor = (id: string): Author => ({ kind: "agent", id });
const humanAuthor = (id: string): Author => ({ kind: "human", id });

describe("writeEvent (integration, real SQLite)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("happy path: persists, returns serialized event, not deduped", async () => {
    const { surface, agentId } = await seedSession();
    const { event, deduped } = await we(surface, agentAuthor(agentId), {
      type: "review.commentAdded",
      data: { body: "looks good" },
    });
    expect(deduped).toBe(false);
    expect(event.type).toBe("review.commentAdded");
    expect(event.data).toEqual({ body: "looks good" });

    const persisted = await prisma.event.findMany({
      where: { surfaceId: surface.id },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.idempotencyKey).toBeNull();
  });

  it("stamps the surface's pinned template version on every event (#268)", async () => {
    // The load-bearing invariant for the polymorphic-render upgrade path:
    // every event carries the version that was active when it was written,
    // so a future upgrade (#267) can hand old events to the new template's
    // JS unchanged.
    const { surface, agentId } = await seedSession();
    const { event } = await we(surface, agentAuthor(agentId), {
      type: "review.commentAdded",
      data: { body: "hi" },
    });
    expect(event.template_version_id).toBe(surface.templateVersionId);
    expect(event.template_version).toBe(surface.templateVersion.version);

    // And the persisted row matches the wire shape.
    const persisted = await prisma.event.findUnique({
      where: { id: Number(event.id) },
    });
    expect(persisted!.templateVersionId).toBe(surface.templateVersionId);
    expect(persisted!.templateVersionNum).toBe(surface.templateVersion.version);
  });

  it("never rewrites a stamped version once an event is persisted (#268)", async () => {
    // The other half of the invariant: a TemplateVersion bump (or a future
    // surface upgrade) must leave the stamp on previously-written events
    // alone. Without that, polymorphic render can't tell which schema an
    // old event was validated against.
    const { surface, agentId } = await seedSession();
    const { event: e1 } = await we(surface, agentAuthor(agentId), {
      type: "review.commentAdded",
      data: { body: "v1 event" },
    });
    const e1VersionId = e1.template_version_id;
    const e1VersionNum = e1.template_version;
    expect(e1VersionId).not.toBeNull();
    expect(e1VersionNum).toBe(1);

    // Append a fresh TemplateVersion (v2) under the same template head.
    const v2 = await prisma.templateVersion.create({
      data: {
        templateId: surface.templateVersion.templateId,
        version: surface.templateVersion.version + 1,
        templateType: "html-inline",
        templateSource: "<html>v2</html>",
        eventSchema: surface.templateVersion.eventSchema as object,
      },
    });

    // Inspect the v1 event directly — it must still carry the v1 stamp.
    const reread = await prisma.event.findUnique({
      where: { id: Number(e1.id) },
    });
    expect(reread!.templateVersionId).toBe(e1VersionId);
    expect(reread!.templateVersionNum).toBe(e1VersionNum);

    // (The surface itself is still pinned to v1 — #267 is what would
    // re-point it. This test just proves the stamp on past rows survives a
    // new sibling version appearing.)
    expect(v2.version).toBe(2);
  });

  it("rejects an event on a closed surface as gone", async () => {
    const { surface, agentId } = await seedSession({ status: "closed" });
    await expect(
      we(surface, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "x" },
      }),
    ).rejects.toMatchObject({ code: "gone" });
  });

  it("rejects an event on an expired surface as gone", async () => {
    const { surface, agentId } = await seedSession({ expiresInMs: -1000 });
    await expect(
      we(surface, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "x" },
      }),
    ).rejects.toMatchObject({ code: "gone" });
  });

  it("rejects an unknown event type via the schema validator", async () => {
    const { surface, agentId } = await seedSession();
    await expect(
      we(surface, agentAuthor(agentId), {
        type: "totally.unknown",
        data: {},
      }),
    ).rejects.toMatchObject({ code: "unknown_event_type" });
  });

  it("rejects a payload that fails the JSON Schema", async () => {
    const { surface, agentId } = await seedSession();
    await expect(
      we(surface, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { wrongField: 1 },
      }),
    ).rejects.toMatchObject({ code: "schema_violation" });
  });

  it("rejects when the author kind is not in emittedBy", async () => {
    const { surface } = await seedSession();
    // Force-override the schema to make review.commentAdded page-only,
    // then prove an agent cannot emit it.
    const updated = await overrideEventSchema(surface, {
      events: {
        "review.commentAdded": {
          payload: {
            type: "object",
            properties: { body: { type: "string" } },
            required: ["body"],
          },
          emittedBy: ["page"],
        },
      },
    });
    await expect(
      we(updated, agentAuthor("a1"), {
        type: "review.commentAdded",
        data: { body: "nope" },
      }),
    ).rejects.toMatchObject({ code: "author_not_allowed" });
  });

  it("rejects payloads over MAX_EVENT_DATA_BYTES", async () => {
    const { surface, agentId } = await seedSession();
    // Override the schema to accept a large free-form payload so we hit the
    // size cap before the JSON Schema check.
    const updated = await overrideEventSchema(surface, {
      events: {
        "big.payload": {
          payload: { type: "object", additionalProperties: true },
          emittedBy: ["agent"],
        },
      },
    });
    const huge = { attachment: "x".repeat(70_000) };
    await expect(
      we(updated, agentAuthor(agentId), {
        type: "big.payload",
        data: huge,
      }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
  });

  describe("idempotency", () => {
    it("returns deduped=true when the same key is replayed sequentially", async () => {
      const { surface, agentId } = await seedSession();
      const key = "idem-" + randomBytes(8).toString("hex");
      const first = await we(surface, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "v1" },
        idempotencyKey: key,
      });
      const second = await we(surface, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "v1" },
        idempotencyKey: key,
      });
      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(true);
      expect(second.event.id).toBe(first.event.id);
      const rows = await prisma.event.findMany({
        where: { surfaceId: surface.id },
      });
      expect(rows).toHaveLength(1);
    });

    it("survives concurrent submissions of the same idempotency key", async () => {
      // This is the regression test for the TOCTOU race. Pre-fix, two parallel
      // writers both saw findUnique=null and both attempted create; the loser
      // bubbled P2002 as a 500. Post-fix, the loser catches P2002 and returns
      // deduped=true.
      const { surface, agentId } = await seedSession();
      const key = "race-" + randomBytes(8).toString("hex");
      const results = await Promise.all(
        Array.from({ length: 5 }).map(() =>
          we(surface, agentAuthor(agentId), {
            type: "review.commentAdded",
            data: { body: "x" },
            idempotencyKey: key,
          }),
        ),
      );
      const deduped = results.filter((r) => r.deduped).length;
      const fresh = results.filter((r) => !r.deduped).length;
      expect(fresh).toBe(1);
      expect(deduped).toBe(4);
      // All five callers see the same row id.
      const ids = new Set(results.map((r) => r.event.id));
      expect(ids.size).toBe(1);
      // And the DB really only has one row.
      const rows = await prisma.event.findMany({
        where: { surfaceId: surface.id },
      });
      expect(rows).toHaveLength(1);
    });

    it("treats different authors with the same key as distinct events", async () => {
      const { surface, agentId } = await seedSession();
      await prisma.participant.create({
        data: {
          surfaceId: surface.id,
          kind: "human",
          identityId: "h_0",
          tokenHash: randomBytes(32).toString("hex"),
          tokenPrefix: "tk_00000",
        },
      });
      const key = "shared-key";
      const a = await we(surface, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "from agent" },
        idempotencyKey: key,
      });
      const b = await we(surface, humanAuthor("h_0"), {
        type: "review.commentAdded",
        data: { body: "from human" },
        idempotencyKey: key,
      });
      expect(a.deduped).toBe(false);
      expect(b.deduped).toBe(false);
      expect(a.event.id).not.toBe(b.event.id);
    });
  });

  describe("webhook side-effect", () => {
    it("does not block or fail the write when the secret cannot be decrypted", async () => {
      // Seed a surface whose callbackSecretEnc is garbage. The event should
      // still commit and the function should return normally — the webhook
      // failure path must not leak into the caller's success path.
      const { surface, agentId } = await seedSession();
      await prisma.surface.update({
        where: { id: surface.id },
        data: {
          callbackUrl: "https://example.invalid/hook",
          callbackSecretEnc: "v1.bad.bad.bad",
          callbackFilter: ["review.*"],
        },
      });
      const broken = await reloadSession(surface.id);
      const { event, deduped } = await we(broken, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "x" },
      });
      expect(deduped).toBe(false);
      expect(event.type).toBe("review.commentAdded");
      const persisted = await prisma.event.findFirst({
        where: { id: Number(event.id) },
      });
      expect(persisted).not.toBeNull();
    });

    it("does not attempt the webhook on a deduped result", async () => {
      // Stub global fetch and verify it's only called once across two identical
      // writes (the second write hits the dedupe path).
      const { surface, agentId } = await seedSession({
        withCallback: true,
        callbackUrl: "https://example.invalid/hook",
        callbackFilter: ["review.*"],
      });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));
      try {
        const key = "dedupe-no-webhook";
        await we(surface, agentAuthor(agentId), {
          type: "review.commentAdded",
          data: { body: "x" },
          idempotencyKey: key,
        });
        await we(surface, agentAuthor(agentId), {
          type: "review.commentAdded",
          data: { body: "x" },
          idempotencyKey: key,
        });
        // Webhook fire is fire-and-forget — give it a tick to dispatch.
        await new Promise((r) => setTimeout(r, 20));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
