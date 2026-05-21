// End-to-end tests for GET /v1/sessions — the list endpoint added in issue
// #161. Focus areas: agent scoping (no cross-agent leakage), the effective-
// status projection (expired rows present as "closed" even if the column
// still says "open"), pagination cursor stability, artifact_id filter, and
// the secrets-redaction contract (no participant tokens, no callback URL,
// no metadata / input_data in the response).

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

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const a = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { id: a.id, apiKey };
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

async function createSession(
  apiKey: string,
  opts: { title?: string; metadata?: unknown; callback?: unknown } = {},
): Promise<{ session_id: string }> {
  const res = await app.fetch(
    new Request("http://t/v1/sessions", {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify({
        artifact: {
          type: "html-inline",
          source: "<html></html>",
          event_schema: eventSchema,
        },
        title: opts.title ?? "Test",
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
        ...(opts.callback !== undefined ? { callback: opts.callback } : {}),
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { session_id: string };
}

interface ListResponseItem {
  session_id: string;
  title: string;
  status: "open" | "closed";
  artifact_id: string | null;
  artifact_version_id: string;
  artifact_version: number;
  participants: Array<{
    participant_id: string;
    kind: "agent" | "human";
    token_prefix: string;
    joined_at: string | null;
    revoked_at: string | null;
  }>;
  created_at: string;
  expires_at: string;
  has_callback: boolean;
}
interface ListResponse {
  items: ListResponseItem[];
  next_cursor: string | null;
}

async function list(
  apiKey: string,
  query: Record<string, string | number> = {},
): Promise<{ status: number; body: ListResponse }> {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
  ).toString();
  const res = await app.fetch(
    new Request(`http://t/v1/sessions${qs ? "?" + qs : ""}`, {
      headers: bearer(apiKey),
    }),
  );
  return { status: res.status, body: (await res.json()) as ListResponse };
}

describe("GET /v1/sessions — list", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("requires bearer auth", async () => {
    const res = await app.fetch(new Request("http://t/v1/sessions"));
    expect(res.status).toBe(401);
  });

  it("returns the caller's sessions only (cross-agent scoping)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const s1 = await createSession(a.apiKey, { title: "A1" });
    await createSession(a.apiKey, { title: "A2" });
    await createSession(b.apiKey, { title: "B1" });

    const { status, body } = await list(a.apiKey);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.items.every((s) => s.title.startsWith("A"))).toBe(true);
    expect(body.items.some((s) => s.session_id === s1.session_id)).toBe(true);
  });

  it("does NOT leak secrets — no token plaintext, callback URL, metadata or input_data", async () => {
    const a = await seedAgent();
    await createSession(a.apiKey, {
      title: "Has secrets",
      metadata: { secret_label: "do-not-leak" },
      callback: {
        url: "https://example.com/webhook?secret=do-not-leak",
        events: ["form.submitted"],
        secret: "shared-secret",
      },
    });

    const { body } = await list(a.apiKey);
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.has_callback).toBe(true);
    const raw = JSON.stringify(item);
    // Tokens, callback url, metadata, input_data must NOT appear in the row.
    expect(raw).not.toContain("do-not-leak");
    expect(raw).not.toContain("shared-secret");
    expect(
      (item as unknown as { callback_url?: string }).callback_url,
    ).toBeUndefined();
    expect(
      (item as unknown as { metadata?: unknown }).metadata,
    ).toBeUndefined();
    expect(
      (item as unknown as { input_data?: unknown }).input_data,
    ).toBeUndefined();

    // The 6-char marker "tok_h_" / "tok_a_" is the START of both the secret
    // token AND the public token_prefix (which IS returned by design). The
    // contract is that plaintext tokens are not returned — verify by checking
    // that no field carries a string long enough to be a full token
    // (prefix + 43-char base64url body = 49 chars).
    for (const p of item.participants) {
      expect(p.token_prefix.startsWith("tok_")).toBe(true);
      // token_prefix is 12 chars: 6-char marker + 6 extra chars.
      expect(p.token_prefix.length).toBe(12);
    }
    // No string field on the row is ≥ 49 chars and starts with tok_ — that
    // would be a full participant token. (artifact_version_id and
    // participant_id are cuids — base36, no underscores; they never collide.)
    const longTokenLike = /tok_[ah]_[A-Za-z0-9_-]{43,}/;
    expect(longTokenLike.test(raw)).toBe(false);
  });

  it("exposes participant_id + token_prefix for each row's participants", async () => {
    const a = await seedAgent();
    await createSession(a.apiKey);

    const { body } = await list(a.apiKey);
    const item = body.items[0]!;
    // session-create mints 1 agent + 1 default human participant.
    expect(item.participants).toHaveLength(2);
    const human = item.participants.find((p) => p.kind === "human")!;
    const agent = item.participants.find((p) => p.kind === "agent")!;
    expect(human.participant_id).toMatch(/^[a-z0-9]+$/);
    expect(human.token_prefix.startsWith("tok_h_")).toBe(true);
    expect(human.token_prefix.length).toBe(12);
    expect(agent.token_prefix.startsWith("tok_a_")).toBe(true);
    expect(human.revoked_at).toBeNull();
    expect(human.joined_at).toBeNull();
  });

  it("default status=open hides expired sessions; status=closed shows them", async () => {
    const a = await seedAgent();
    const open = await createSession(a.apiKey, { title: "Open" });
    const expired = await createSession(a.apiKey, { title: "Expired" });
    // Backdate expiresAt to past — effective-closed even though column says open.
    await prisma.session.update({
      where: { id: expired.session_id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const openOnly = (await list(a.apiKey)).body;
    expect(openOnly.items.map((s) => s.session_id)).toEqual([open.session_id]);

    const closedOnly = (await list(a.apiKey, { status: "closed" })).body;
    expect(closedOnly.items.map((s) => s.session_id)).toEqual([
      expired.session_id,
    ]);
    expect(closedOnly.items[0]!.status).toBe("closed");

    const all = (await list(a.apiKey, { status: "all" })).body;
    expect(all.items.map((s) => s.session_id).sort()).toEqual(
      [open.session_id, expired.session_id].sort(),
    );
  });

  it("rejects invalid status / limit / cursor with 400", async () => {
    const a = await seedAgent();
    expect((await list(a.apiKey, { status: "purple" })).status).toBe(400);
    expect((await list(a.apiKey, { limit: 0 })).status).toBe(400);
    expect((await list(a.apiKey, { limit: 201 })).status).toBe(400);
    expect((await list(a.apiKey, { cursor: "not-a-cursor" })).status).toBe(400);
  });

  it("paginates with next_cursor (round-trips opaque cursor)", async () => {
    const a = await seedAgent();
    // Create 5 sessions sequentially so createdAt orderings are stable.
    for (let i = 0; i < 5; i++) {
      await createSession(a.apiKey, { title: `S${i}` });
    }

    const page1 = (await list(a.apiKey, { limit: 2 })).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = (
      await list(a.apiKey, { limit: 2, cursor: page1.next_cursor! })
    ).body;
    expect(page2.items).toHaveLength(2);
    expect(page2.next_cursor).toBeTruthy();

    const page3 = (
      await list(a.apiKey, { limit: 2, cursor: page2.next_cursor! })
    ).body;
    expect(page3.items).toHaveLength(1);
    expect(page3.next_cursor).toBeNull();

    // No row appears twice across the three pages.
    const ids = [
      ...page1.items.map((s) => s.session_id),
      ...page2.items.map((s) => s.session_id),
      ...page3.items.map((s) => s.session_id),
    ];
    expect(new Set(ids).size).toBe(5);
  });

  it("filters by artifact_id", async () => {
    const a = await seedAgent();
    // First session uses an inline artifact — its head id is anonymous.
    const inlineSession = await createSession(a.apiKey, { title: "Inline" });
    // Look up the inline artifact id so the filter probe is concrete.
    const inlineRow = await prisma.session.findUnique({
      where: { id: inlineSession.session_id },
      include: { artifactVersion: true },
    });
    const inlineArtifactId = inlineRow!.artifactVersion.artifactId;

    await createSession(a.apiKey, { title: "Other" });

    const filtered = (await list(a.apiKey, { artifact_id: inlineArtifactId }))
      .body;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]!.session_id).toBe(inlineSession.session_id);
    // For inline (anonymous) artifacts the response's artifact_id is null,
    // even though the filter matched.
    expect(filtered.items[0]!.artifact_id).toBeNull();

    // Filter to a non-matching artifact id — empty page.
    const empty = (await list(a.apiKey, { artifact_id: "art_doesnotexist" }))
      .body;
    expect(empty.items).toHaveLength(0);
  });
});
