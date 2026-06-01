// End-to-end tests for GET /v1/panes — the list endpoint added in issue
// #161. Focus areas: agent scoping (no cross-agent leakage), the effective-
// status projection (expired rows present as "closed" even if the column
// still says "open"), pagination cursor stability, template_id filter, and
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

async function createPane(
  apiKey: string,
  opts: { title?: string; metadata?: unknown; callback?: unknown } = {},
): Promise<{ pane_id: string }> {
  const res = await app.fetch(
    new Request("http://t/v1/panes", {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify({
        template: {
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
  return (await res.json()) as { pane_id: string };
}

interface ListResponseItem {
  pane_id: string;
  title: string;
  status: "open" | "closed";
  template_id: string | null;
  template_version_id: string;
  template_version: number;
  active_human_participants: number;
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
    new Request(`http://t/v1/panes${qs ? "?" + qs : ""}`, {
      headers: bearer(apiKey),
    }),
  );
  return { status: res.status, body: (await res.json()) as ListResponse };
}

describe("GET /v1/panes — list", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("requires bearer auth", async () => {
    const res = await app.fetch(new Request("http://t/v1/panes"));
    expect(res.status).toBe(401);
  });

  it("returns the caller's panes only (cross-agent scoping)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const s1 = await createPane(a.apiKey, { title: "A1" });
    await createPane(a.apiKey, { title: "A2" });
    await createPane(b.apiKey, { title: "B1" });

    const { status, body } = await list(a.apiKey);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.items.every((s) => s.title.startsWith("A"))).toBe(true);
    expect(body.items.some((s) => s.pane_id === s1.pane_id)).toBe(true);
  });

  it("does NOT leak secrets — no token plaintext, callback URL, metadata or input_data", async () => {
    const a = await seedAgent();
    await createPane(a.apiKey, {
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

    // The list MUST NOT inline the participants array — agents with many
    // panes would pay the bandwidth on every call. The full array lives
    // at GET /v1/panes/:id/participants. Verify by checking that no
    // string field is long enough to be a participant token plaintext
    // (49 chars), and that no `participants` array leaked through.
    expect(
      (item as unknown as { participants?: unknown }).participants,
    ).toBeUndefined();
    const longTokenLike = /tok_[ah]_[A-Za-z0-9_-]{43,}/;
    expect(longTokenLike.test(raw)).toBe(false);
  });

  it("exposes the active human count but not the full participant array", async () => {
    const a = await seedAgent();
    await createPane(a.apiKey);

    const { body } = await list(a.apiKey);
    const item = body.items[0]!;
    // pane-create mints 1 default human participant; the agent
    // participant doesn't count for the human cap.
    expect(item.active_human_participants).toBe(1);
    // No full participant array on the list response.
    expect(
      (item as unknown as { participants?: unknown }).participants,
    ).toBeUndefined();
  });

  it("active_human_participants drops when a human is revoked", async () => {
    const a = await seedAgent();
    const { pane_id } = await createPane(a.apiKey);

    // The default human's id, fetched directly from the DB.
    const p = await prisma.participant.findFirst({
      where: { paneId: pane_id, kind: "human" },
    });
    expect(p).not.toBeNull();
    const revokeRes = await app.fetch(
      new Request(`http://t/v1/panes/${pane_id}/participants/${p!.id}`, {
        method: "DELETE",
        headers: bearer(a.apiKey),
      }),
    );
    expect(revokeRes.status).toBe(204);

    const { body } = await list(a.apiKey);
    const item = body.items.find((s) => s.pane_id === pane_id)!;
    expect(item.active_human_participants).toBe(0);
  });

  it("default status=open hides expired panes; status=closed shows them", async () => {
    const a = await seedAgent();
    const open = await createPane(a.apiKey, { title: "Open" });
    const expired = await createPane(a.apiKey, { title: "Expired" });
    // Backdate expiresAt to past — effective-closed even though column says open.
    await prisma.pane.update({
      where: { id: expired.pane_id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const openOnly = (await list(a.apiKey)).body;
    expect(openOnly.items.map((s) => s.pane_id)).toEqual([open.pane_id]);

    const closedOnly = (await list(a.apiKey, { status: "closed" })).body;
    expect(closedOnly.items.map((s) => s.pane_id)).toEqual([expired.pane_id]);
    expect(closedOnly.items[0]!.status).toBe("closed");

    const all = (await list(a.apiKey, { status: "all" })).body;
    expect(all.items.map((s) => s.pane_id).sort()).toEqual(
      [open.pane_id, expired.pane_id].sort(),
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
    // Create 5 panes sequentially so createdAt orderings are stable.
    for (let i = 0; i < 5; i++) {
      await createPane(a.apiKey, { title: `S${i}` });
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
      ...page1.items.map((s) => s.pane_id),
      ...page2.items.map((s) => s.pane_id),
      ...page3.items.map((s) => s.pane_id),
    ];
    expect(new Set(ids).size).toBe(5);
  });

  it("filters by template_id", async () => {
    const a = await seedAgent();
    // First pane uses an inline template — its head id is anonymous.
    const inlinePane = await createPane(a.apiKey, { title: "Inline" });
    // Look up the inline template id so the filter probe is concrete.
    const inlineRow = await prisma.pane.findUnique({
      where: { id: inlinePane.pane_id },
      include: { templateVersion: true },
    });
    const inlineArtifactId = inlineRow!.templateVersion.templateId;

    await createPane(a.apiKey, { title: "Other" });

    const filtered = (await list(a.apiKey, { template_id: inlineArtifactId }))
      .body;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]!.pane_id).toBe(inlinePane.pane_id);
    // For inline (anonymous) templates the response's template_id is null,
    // even though the filter matched.
    expect(filtered.items[0]!.template_id).toBeNull();

    // Filter to a non-matching template id — empty page.
    const empty = (await list(a.apiKey, { template_id: "art_doesnotexist" }))
      .body;
    expect(empty.items).toHaveLength(0);
  });
});
