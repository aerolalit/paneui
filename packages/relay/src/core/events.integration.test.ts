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
import type { PrismaClient, Session } from "@prisma/client";
import type { Author } from "../types.js";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";
import { loadConfig, type Config } from "../config.js";
import { encryptSecret, _resetKeyCacheForTests } from "../crypto.js";
import {
  writeEvent,
  type WriteEventInput,
  type WriteEventResult,
} from "./events.js";

let testDb: TestDb;
let prisma: PrismaClient;
let config: Config;

// Thin wrapper that binds writeEvent to the injected { prisma, config } deps so
// the individual test bodies stay focused on session/author/input.
function we(
  session: Session,
  author: Author,
  input: WriteEventInput,
): Promise<WriteEventResult> {
  return writeEvent({ prisma, config }, session, author, input);
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
): Promise<{ session: Session; agentId: string }> {
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: `pane_${randomBytes(3).toString("hex")}`,
    },
  });
  const session = await prisma.session.create({
    data: {
      id: `ses_${randomBytes(8).toString("hex")}`,
      agentId: agent.id,
      artifactType: "html-inline",
      artifactSource: "<html></html>",
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
      status: opts.status ?? "open",
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
    },
  });
  return { session, agentId: agent.id };
}

const agentAuthor = (id: string): Author => ({ kind: "agent", id });
const humanAuthor = (id: string): Author => ({ kind: "human", id });

describe("writeEvent (integration, real SQLite)", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("happy path: persists, returns serialized event, not deduped", async () => {
    const { session, agentId } = await seedSession();
    const { event, deduped } = await we(session, agentAuthor(agentId), {
      type: "review.commentAdded",
      data: { body: "looks good" },
    });
    expect(deduped).toBe(false);
    expect(event.type).toBe("review.commentAdded");
    expect(event.data).toEqual({ body: "looks good" });

    const persisted = await prisma.event.findMany({
      where: { sessionId: session.id },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.idempotencyKey).toBeNull();
  });

  it("rejects an event on a closed session as gone", async () => {
    const { session, agentId } = await seedSession({ status: "closed" });
    await expect(
      we(session, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "x" },
      }),
    ).rejects.toMatchObject({ code: "gone" });
  });

  it("rejects an event on an expired session as gone", async () => {
    const { session, agentId } = await seedSession({ expiresInMs: -1000 });
    await expect(
      we(session, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "x" },
      }),
    ).rejects.toMatchObject({ code: "gone" });
  });

  it("rejects an unknown event type via the schema validator", async () => {
    const { session, agentId } = await seedSession();
    await expect(
      we(session, agentAuthor(agentId), {
        type: "totally.unknown",
        data: {},
      }),
    ).rejects.toMatchObject({ code: "unknown_event_type" });
  });

  it("rejects a payload that fails the JSON Schema", async () => {
    const { session, agentId } = await seedSession();
    await expect(
      we(session, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { wrongField: 1 },
      }),
    ).rejects.toMatchObject({ code: "schema_violation" });
  });

  it("rejects when the author kind is not in emittedBy", async () => {
    const { session } = await seedSession();
    // Force-override the schema to make review.commentAdded page-only,
    // then prove an agent cannot emit it.
    const updated = await prisma.session.update({
      where: { id: session.id },
      data: {
        eventSchema: {
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
    const { session, agentId } = await seedSession();
    // Override the schema to accept a large free-form payload so we hit the
    // size cap before the JSON Schema check.
    const updated = await prisma.session.update({
      where: { id: session.id },
      data: {
        eventSchema: {
          events: {
            "big.payload": {
              payload: { type: "object", additionalProperties: true },
              emittedBy: ["agent"],
            },
          },
        },
      },
    });
    const huge = { blob: "x".repeat(70_000) };
    await expect(
      we(updated, agentAuthor(agentId), {
        type: "big.payload",
        data: huge,
      }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
  });

  describe("idempotency", () => {
    it("returns deduped=true when the same key is replayed sequentially", async () => {
      const { session, agentId } = await seedSession();
      const key = "idem-" + randomBytes(8).toString("hex");
      const first = await we(session, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "v1" },
        idempotencyKey: key,
      });
      const second = await we(session, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "v1" },
        idempotencyKey: key,
      });
      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(true);
      expect(second.event.id).toBe(first.event.id);
      const rows = await prisma.event.findMany({
        where: { sessionId: session.id },
      });
      expect(rows).toHaveLength(1);
    });

    it("survives concurrent submissions of the same idempotency key", async () => {
      // This is the regression test for the TOCTOU race. Pre-fix, two parallel
      // writers both saw findUnique=null and both attempted create; the loser
      // bubbled P2002 as a 500. Post-fix, the loser catches P2002 and returns
      // deduped=true.
      const { session, agentId } = await seedSession();
      const key = "race-" + randomBytes(8).toString("hex");
      const results = await Promise.all(
        Array.from({ length: 5 }).map(() =>
          we(session, agentAuthor(agentId), {
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
        where: { sessionId: session.id },
      });
      expect(rows).toHaveLength(1);
    });

    it("treats different authors with the same key as distinct events", async () => {
      const { session, agentId } = await seedSession();
      await prisma.participant.create({
        data: {
          sessionId: session.id,
          kind: "human",
          identityId: "h_0",
          tokenHash: randomBytes(32).toString("hex"),
          tokenPrefix: "tk_00000",
        },
      });
      const key = "shared-key";
      const a = await we(session, agentAuthor(agentId), {
        type: "review.commentAdded",
        data: { body: "from agent" },
        idempotencyKey: key,
      });
      const b = await we(session, humanAuthor("h_0"), {
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
      // Seed a session whose callbackSecretEnc is garbage. The event should
      // still commit and the function should return normally — the webhook
      // failure path must not leak into the caller's success path.
      const { session, agentId } = await seedSession();
      const broken = await prisma.session.update({
        where: { id: session.id },
        data: {
          callbackUrl: "https://example.invalid/hook",
          callbackSecretEnc: "v1.bad.bad.bad",
          callbackFilter: ["review.*"],
        },
      });
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
      const { session, agentId } = await seedSession({
        withCallback: true,
        callbackUrl: "https://example.invalid/hook",
        callbackFilter: ["review.*"],
      });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 200 }));
      try {
        const key = "dedupe-no-webhook";
        await we(session, agentAuthor(agentId), {
          type: "review.commentAdded",
          data: { body: "x" },
          idempotencyKey: key,
        });
        await we(session, agentAuthor(agentId), {
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
