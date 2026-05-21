// End-to-end tests for POST /v1/sessions/:id/participants and
// DELETE /v1/sessions/:id/participants/:participant_id — the mint + revoke
// primitives added in issue #161. Together they replace the destructive
// `pane delete + create` workaround for the lost-URL case.

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

// Small cap so the "409 at the cap" test doesn't have to mint 32 humans.
const CAP = 3;

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
      MAX_PARTICIPANTS_PER_SESSION: String(CAP),
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

function bearer(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

const eventSchema = {
  events: {
    ping: { payload: { type: "object" }, emittedBy: ["page", "agent"] },
  },
};

async function createSession(apiKey: string): Promise<string> {
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
        title: "Test",
      }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { session_id: string }).session_id;
}

interface MintResponse {
  participant_id: string;
  kind: "human";
  token: string;
  url: string;
  created_at: string;
}

async function mint(
  apiKey: string,
  sessionId: string,
  body: unknown = { kind: "human" },
): Promise<{
  status: number;
  body: MintResponse | { error: { code: string } };
}> {
  const res = await app.fetch(
    new Request(`http://t/v1/sessions/${sessionId}/participants`, {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as MintResponse | { error: { code: string } },
  };
}

async function revoke(
  apiKey: string,
  sessionId: string,
  participantId: string,
): Promise<{ status: number }> {
  const res = await app.fetch(
    new Request(
      `http://t/v1/sessions/${sessionId}/participants/${participantId}`,
      { method: "DELETE", headers: bearer(apiKey) },
    ),
  );
  return { status: res.status };
}

// Fetch the agent participant id for a session — used by the "cannot revoke
// the agent participant" test.
async function agentParticipantId(sessionId: string): Promise<string> {
  const p = await prisma.participant.findFirst({
    where: { sessionId, kind: "agent" },
  });
  return p!.id;
}

// Same for a default human participant.
async function humanParticipantId(sessionId: string): Promise<string> {
  const p = await prisma.participant.findFirst({
    where: { sessionId, kind: "human" },
  });
  return p!.id;
}

interface ParticipantsListResponse {
  session_id: string;
  items: Array<{
    participant_id: string;
    kind: "agent" | "human";
    token_prefix: string;
    joined_at: string | null;
    revoked_at: string | null;
  }>;
}

async function listParticipants(
  apiKey: string,
  sessionId: string,
): Promise<{ status: number; body: ParticipantsListResponse }> {
  const res = await app.fetch(
    new Request(`http://t/v1/sessions/${sessionId}/participants`, {
      headers: bearer(apiKey),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as ParticipantsListResponse,
  };
}

describe("GET /v1/sessions/:id/participants — list", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns every participant on the session (agent + humans, active + revoked)", async () => {
    const a = await seedAgent();
    const sid = await createSession(a.apiKey);
    // Mint one extra human + revoke it so we exercise the revoked-rows path.
    const minted = (await mint(a.apiKey, sid)).body as MintResponse;
    expect((await revoke(a.apiKey, sid, minted.participant_id)).status).toBe(
      204,
    );

    const { status, body } = await listParticipants(a.apiKey, sid);
    expect(status).toBe(200);
    expect(body.session_id).toBe(sid);
    // 1 agent + 1 default human + 1 minted-then-revoked human = 3 rows.
    expect(body.items).toHaveLength(3);
    const agentRows = body.items.filter((p) => p.kind === "agent");
    const humanRows = body.items.filter((p) => p.kind === "human");
    expect(agentRows).toHaveLength(1);
    expect(humanRows).toHaveLength(2);
    const revokedRow = humanRows.find((p) => p.revoked_at !== null);
    expect(revokedRow).toBeDefined();
    expect(revokedRow!.participant_id).toBe(minted.participant_id);
  });

  it("does NOT leak token plaintext — only token_prefix", async () => {
    const a = await seedAgent();
    const sid = await createSession(a.apiKey);
    const { body } = await listParticipants(a.apiKey, sid);
    const raw = JSON.stringify(body);
    // A token plaintext is 49 chars (6-char marker + 43-char base64url body).
    const longTokenLike = /tok_[ah]_[A-Za-z0-9_-]{43,}/;
    expect(longTokenLike.test(raw)).toBe(false);
    for (const p of body.items) {
      expect(p.token_prefix.length).toBe(12);
      expect(p.token_prefix.startsWith("tok_")).toBe(true);
    }
  });

  it("404s when the session belongs to a different agent", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const sid = await createSession(a.apiKey);
    const res = await app.fetch(
      new Request(`http://t/v1/sessions/${sid}/participants`, {
        headers: bearer(b.apiKey),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("requires bearer auth", async () => {
    const a = await seedAgent();
    const sid = await createSession(a.apiKey);
    const res = await app.fetch(
      new Request(`http://t/v1/sessions/${sid}/participants`),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/sessions/:id/participants — mint", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("mints a fresh human URL on an existing session", async () => {
    const a = await seedAgent();
    const sid = await createSession(a.apiKey);

    const res = await mint(a.apiKey, sid);
    expect(res.status).toBe(201);
    const body = res.body as MintResponse;
    expect(body.kind).toBe("human");
    expect(body.token.startsWith("tok_h_")).toBe(true);
    expect(body.url).toBe(`http://localhost:3000/s/${body.token}`);
    expect(body.participant_id).toMatch(/^[a-z0-9]+$/);

    // The new participant is reachable via the bridge.
    const bridgeRes = await app.fetch(
      new Request(`http://t/s/${body.token}/content`),
    );
    expect(bridgeRes.status).toBe(200);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/sessions/ses_nope/participants", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("404s when the session belongs to a different agent (existence-oracle parity)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const sid = await createSession(a.apiKey);
    const res = await mint(b.apiKey, sid);
    expect(res.status).toBe(404);
  });

  it("410s on an effectively-closed session (expired or DELETE'd)", async () => {
    const a = await seedAgent();
    const expiredSid = await createSession(a.apiKey);
    await prisma.session.update({
      where: { id: expiredSid },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect((await mint(a.apiKey, expiredSid)).status).toBe(410);

    const closedSid = await createSession(a.apiKey);
    const delRes = await app.fetch(
      new Request(`http://t/v1/sessions/${closedSid}`, {
        method: "DELETE",
        headers: bearer(a.apiKey),
      }),
    );
    expect(delRes.status).toBe(204);
    expect((await mint(a.apiKey, closedSid)).status).toBe(410);
  });

  it("rejects body kinds other than 'human' with 400", async () => {
    const a = await seedAgent();
    const sid = await createSession(a.apiKey);
    expect((await mint(a.apiKey, sid, { kind: "agent" })).status).toBe(400);
    expect((await mint(a.apiKey, sid, {})).status).toBe(400);
  });

  it("409s at the active-human cap; revoking a participant frees a slot", async () => {
    const a = await seedAgent();
    const sid = await createSession(a.apiKey);
    // Session was created with 1 default human. Cap is CAP — mint CAP-1 more
    // to fill it.
    for (let i = 0; i < CAP - 1; i++) {
      expect((await mint(a.apiKey, sid)).status).toBe(201);
    }
    const over = await mint(a.apiKey, sid);
    expect(over.status).toBe(409);
    const err = over.body as { error: { code: string } };
    expect(err.error.code).toBe("conflict");

    // Revoke one — a slot reopens.
    const pid = await humanParticipantId(sid);
    expect((await revoke(a.apiKey, sid, pid)).status).toBe(204);
    expect((await mint(a.apiKey, sid)).status).toBe(201);
  });
});

describe("DELETE /v1/sessions/:id/participants/:participant_id — revoke", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("revokes a human participant; bridge /s/:token then 404s", async () => {
    const a = await seedAgent();
    const sid = await createSession(a.apiKey);
    const minted = (await mint(a.apiKey, sid)).body as MintResponse;

    // Token works first.
    expect(
      (await app.fetch(new Request(`http://t/s/${minted.token}/content`)))
        .status,
    ).toBe(200);

    expect((await revoke(a.apiKey, sid, minted.participant_id)).status).toBe(
      204,
    );
    // Bridge now 404s for the revoked token.
    expect(
      (await app.fetch(new Request(`http://t/s/${minted.token}/content`)))
        .status,
    ).toBe(404);
  });

  it("is idempotent — revoking twice still returns 204", async () => {
    const a = await seedAgent();
    const sid = await createSession(a.apiKey);
    const pid = await humanParticipantId(sid);

    expect((await revoke(a.apiKey, sid, pid)).status).toBe(204);
    expect((await revoke(a.apiKey, sid, pid)).status).toBe(204);
  });

  it("unknown participant id returns 204 (idempotent miss)", async () => {
    const a = await seedAgent();
    const sid = await createSession(a.apiKey);
    expect((await revoke(a.apiKey, sid, "p_doesnotexist")).status).toBe(204);
  });

  it("cross-session participant id returns 204 (idempotent miss)", async () => {
    const a = await seedAgent();
    const sid1 = await createSession(a.apiKey);
    const sid2 = await createSession(a.apiKey);
    const pidOfSid1 = await humanParticipantId(sid1);
    // Asking sid2 to revoke a participant that belongs to sid1 is treated as
    // a no-op miss, not a 404 with information leakage.
    expect((await revoke(a.apiKey, sid2, pidOfSid1)).status).toBe(204);
    // Confirm the actual row is NOT revoked.
    const stillActive = await prisma.participant.findUnique({
      where: { id: pidOfSid1 },
    });
    expect(stillActive!.revokedAt).toBeNull();
  });

  it("rejects revoking the agent participant with 400 (load-bearing for WS)", async () => {
    const a = await seedAgent();
    const sid = await createSession(a.apiKey);
    const agentPid = await agentParticipantId(sid);
    const res = await app.fetch(
      new Request(`http://t/v1/sessions/${sid}/participants/${agentPid}`, {
        method: "DELETE",
        headers: bearer(a.apiKey),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; hint?: string };
    };
    expect(body.error.code).toBe("invalid_request");
  });

  it("404s when the session belongs to a different agent", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const sid = await createSession(a.apiKey);
    const pid = await humanParticipantId(sid);
    expect((await revoke(b.apiKey, sid, pid)).status).toBe(404);
  });
});
