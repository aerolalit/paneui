// End-to-end tests for POST /v1/panes/:id/participants and
// DELETE /v1/panes/:id/participants/:participant_id — the mint + revoke
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
      MAX_PARTICIPANTS_PER_PANE: String(CAP),
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

async function createPane(apiKey: string): Promise<string> {
  const res = await app.fetch(
    new Request("http://t/v1/panes", {
      method: "POST",
      headers: bearer(apiKey),
      body: JSON.stringify({
        template: {
          name: "Test template",
          type: "html-inline",
          source: "<html></html>",
          event_schema: eventSchema,
        },
        title: "Test",
      }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { pane_id: string }).pane_id;
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
  paneId: string,
  body: unknown = { kind: "human" },
): Promise<{
  status: number;
  body: MintResponse | { error: { code: string } };
}> {
  const res = await app.fetch(
    new Request(`http://t/v1/panes/${paneId}/participants`, {
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
  paneId: string,
  participantId: string,
): Promise<{ status: number }> {
  const res = await app.fetch(
    new Request(`http://t/v1/panes/${paneId}/participants/${participantId}`, {
      method: "DELETE",
      headers: bearer(apiKey),
    }),
  );
  return { status: res.status };
}

// Fetch the agent participant id for a pane — used by the "cannot revoke
// the agent participant" test.
async function agentParticipantId(paneId: string): Promise<string> {
  const p = await prisma.participant.findFirst({
    where: { paneId, kind: "agent" },
  });
  return p!.id;
}

// Same for a default human participant.
async function humanParticipantId(paneId: string): Promise<string> {
  const p = await prisma.participant.findFirst({
    where: { paneId, kind: "human" },
  });
  return p!.id;
}

interface ParticipantsListResponse {
  pane_id: string;
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
  paneId: string,
): Promise<{ status: number; body: ParticipantsListResponse }> {
  const res = await app.fetch(
    new Request(`http://t/v1/panes/${paneId}/participants`, {
      headers: bearer(apiKey),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as ParticipantsListResponse,
  };
}

describe("GET /v1/panes/:id/participants — list", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns every participant on the pane (agent + humans, active + revoked)", async () => {
    const a = await seedAgent();
    const sid = await createPane(a.apiKey);
    // Mint one extra human + revoke it so we exercise the revoked-rows path.
    const minted = (await mint(a.apiKey, sid)).body as MintResponse;
    expect((await revoke(a.apiKey, sid, minted.participant_id)).status).toBe(
      204,
    );

    const { status, body } = await listParticipants(a.apiKey, sid);
    expect(status).toBe(200);
    expect(body.pane_id).toBe(sid);
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
    const sid = await createPane(a.apiKey);
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

  it("404s when the pane belongs to a different agent", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const sid = await createPane(a.apiKey);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${sid}/participants`, {
        headers: bearer(b.apiKey),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("requires bearer auth", async () => {
    const a = await seedAgent();
    const sid = await createPane(a.apiKey);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${sid}/participants`),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/panes/:id/participants — mint", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("mints a fresh human URL on an existing pane", async () => {
    const a = await seedAgent();
    const sid = await createPane(a.apiKey);

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
      new Request("http://t/v1/panes/pan_nope/participants", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("404s when the pane belongs to a different agent (existence-oracle parity)", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const sid = await createPane(a.apiKey);
    const res = await mint(b.apiKey, sid);
    expect(res.status).toBe(404);
  });

  it("410s on an effectively-closed pane (expired or DELETE'd)", async () => {
    const a = await seedAgent();
    const expiredSid = await createPane(a.apiKey);
    await prisma.pane.update({
      where: { id: expiredSid },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect((await mint(a.apiKey, expiredSid)).status).toBe(410);

    const closedSid = await createPane(a.apiKey);
    const delRes = await app.fetch(
      new Request(`http://t/v1/panes/${closedSid}`, {
        method: "DELETE",
        headers: bearer(a.apiKey),
      }),
    );
    expect(delRes.status).toBe(204);
    expect((await mint(a.apiKey, closedSid)).status).toBe(410);
  });

  it("rejects body kinds other than 'human' with 400", async () => {
    const a = await seedAgent();
    const sid = await createPane(a.apiKey);
    expect((await mint(a.apiKey, sid, { kind: "agent" })).status).toBe(400);
    expect((await mint(a.apiKey, sid, {})).status).toBe(400);
  });

  it("409s at the active-human cap; revoking a participant frees a slot", async () => {
    const a = await seedAgent();
    const sid = await createPane(a.apiKey);
    // Pane was created with 1 default human. Cap is CAP — mint CAP-1 more
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

  it("identityId stays unique across a revoke-then-mint cycle (#201)", async () => {
    // Regression test for #201: pre-fix the new participant's identityId
    // was derived from `count({ revokedAt: null })`, which is not
    // monotonic — revoking participant h_0 made the next mint reuse
    // `h_1` (already held by the still-active second participant), and
    // the WS handler's `findFirst({ where: { paneId, identityId } })`
    // would non-deterministically resolve events to whichever row sorted
    // first. The fix counts ALL human participants (including revoked)
    // for the index so labels never alias within a pane.
    const a = await seedAgent();
    const sid = await createPane(a.apiKey);

    // Mint a second human so the pane has h_0 (default) + h_1.
    expect((await mint(a.apiKey, sid)).status).toBe(201);

    const initial = await prisma.participant.findMany({
      where: { paneId: sid, kind: "human" },
      orderBy: { id: "asc" }, // cuid is time-monotonic → insertion order
      select: { id: true, identityId: true, revokedAt: true },
    });
    expect(initial).toHaveLength(2);
    expect(initial.map((p) => p.identityId)).toEqual(["h_0", "h_1"]);

    // Revoke h_0 — leaves h_1 active. Then mint a third.
    expect((await revoke(a.apiKey, sid, initial[0]!.id)).status).toBe(204);
    expect((await mint(a.apiKey, sid)).status).toBe(201);

    const all = await prisma.participant.findMany({
      where: { paneId: sid, kind: "human" },
      orderBy: { id: "asc" }, // cuid is time-monotonic → insertion order
      select: { identityId: true, revokedAt: true },
    });
    // Three rows total: h_0 (revoked), h_1 (active), h_2 (newly minted).
    // Pre-fix the third would have been `h_1`, colliding with the live row.
    const active = all.filter((p) => !p.revokedAt).map((p) => p.identityId);
    expect(new Set(active).size).toBe(active.length); // no aliasing
    expect(all.map((p) => p.identityId)).toEqual(["h_0", "h_1", "h_2"]);
  });

  it("concurrent mints retry on P2002 and produce distinct identityIds (#215)", async () => {
    // Two parallel POSTs to the mint route both read everMintedHumans=N
    // and both try `h_${N}`. Pre-#215 the second would have succeeded
    // anyway and silently aliased h_N (corrupting downstream
    // findFirst({ identityId }) attribution). Post-#215 the DB's
    // (paneId, identityId) unique index serialises the write — exactly
    // one wins on first try; the loser sees P2002, re-reads the count,
    // and retries to get `h_${N+1}`. Both succeed; both rows are distinct.
    //
    // Test config caps the pane at CAP humans total (3). Pane is
    // created with 1 default (h_0), so we fire CAP-1=2 concurrent mints
    // to fill the cap without ever bumping into it.
    const a = await seedAgent();
    const sid = await createPane(a.apiKey);

    const N = CAP - 1; // 2 — exercises the race without tripping the cap
    const responses = await Promise.all(
      Array.from({ length: N }, () => mint(a.apiKey, sid)),
    );

    // All succeed — the retry loop closes the race.
    for (const r of responses) {
      expect(r.status).toBe(201);
    }

    // Every minted participant has a distinct identityId. The DB's unique
    // constraint enforces this even if the retry logic had a bug — but
    // assert at the row level so a future refactor that routes around the
    // constraint (e.g. soft-deleting and re-inserting) trips the test.
    const allHumans = await prisma.participant.findMany({
      where: { paneId: sid, kind: "human" },
      select: { identityId: true },
    });
    expect(allHumans).toHaveLength(N + 1); // +1 for the default h_0
    const identityIds = allHumans.map((p) => p.identityId);
    expect(new Set(identityIds).size).toBe(identityIds.length);
    // The labels run h_0 through h_N inclusive (no gaps; the retry loop
    // doesn't skip indices on collision — it re-reads the count + retries).
    expect(identityIds.sort()).toEqual(
      Array.from({ length: N + 1 }, (_, i) => `h_${i}`).sort(),
    );
  });
});

describe("DELETE /v1/panes/:id/participants/:participant_id — revoke", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("revokes a human participant; bridge /s/:token then 404s", async () => {
    const a = await seedAgent();
    const sid = await createPane(a.apiKey);
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
    const sid = await createPane(a.apiKey);
    const pid = await humanParticipantId(sid);

    expect((await revoke(a.apiKey, sid, pid)).status).toBe(204);
    expect((await revoke(a.apiKey, sid, pid)).status).toBe(204);
  });

  it("unknown participant id returns 204 (idempotent miss)", async () => {
    const a = await seedAgent();
    const sid = await createPane(a.apiKey);
    expect((await revoke(a.apiKey, sid, "p_doesnotexist")).status).toBe(204);
  });

  it("cross-pane participant id returns 204 (idempotent miss)", async () => {
    const a = await seedAgent();
    const sid1 = await createPane(a.apiKey);
    const sid2 = await createPane(a.apiKey);
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
    const sid = await createPane(a.apiKey);
    const agentPid = await agentParticipantId(sid);
    const res = await app.fetch(
      new Request(`http://t/v1/panes/${sid}/participants/${agentPid}`, {
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

  it("404s when the pane belongs to a different agent", async () => {
    const a = await seedAgent();
    const b = await seedAgent();
    const sid = await createPane(a.apiKey);
    const pid = await humanParticipantId(sid);
    expect((await revoke(b.apiKey, sid, pid)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Regression guard for #231 — under high concurrency, the original
// MAX_MINT_ATTEMPTS=5 retry budget starved: ~8 concurrent mints already
// leaked P2002 as 500s, and the failure rate climbed to ~60% by N=20.
// The fix makes the budget proportional to the cap (Math.max(5, cap)),
// which provably bounds the worst-case attempt count (cap-check at the top
// of each iteration limits concurrent in-flight mints to cap; each round
// produces ≥1 winner, so a worst-case loser succeeds within cap attempts).
//
// The describe block above uses CAP=3 (so the cap-409 test stays cheap),
// which never exercises this regime — the racing test there fires
// N=CAP-1=2 mints, well inside any sane budget. This block re-builds the
// app with a production-shaped cap and fires N=CAP-1 contenders to assert
// the budget actually scales. The helpers below (`mint`, `createPane`,
// `humanParticipantId`) close over the module-level `app`, so re-binding
// it here propagates to all of them automatically — same pattern
// register-modes.e2e.test.ts uses for its multi-config layout.
// ---------------------------------------------------------------------------
describe("POST /v1/panes/:id/participants — high-contention mint (#231)", () => {
  const BIG_CAP = 20;

  beforeAll(() => {
    app = buildApp(
      loadConfig({
        DATABASE_URL: testDb.dbUrl,
        PUBLIC_URL: "http://localhost:3000",
        MAX_PARTICIPANTS_PER_PANE: String(BIG_CAP),
        // The general per-IP rate limiter would 429-bomb a Promise.all of
        // 19 mints from the same in-process source. Disable it for this
        // describe; rate-limit.e2e.test.ts owns coverage for that pane.
        RATE_LIMIT: "0",
      }),
      prisma,
    );
  });

  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("BIG_CAP-1 concurrent mints all return 201 with distinct identityIds — no P2002 leaks as 500", async () => {
    const a = await seedAgent();
    const sid = await createPane(a.apiKey);

    const N = BIG_CAP - 1; // 19 — room left over the implicit h_0 from create
    const responses = await Promise.all(
      Array.from({ length: N }, () => mint(a.apiKey, sid)),
    );

    // The load-bearing assertion: zero P2002-as-500 leaks. Pre-fix, this
    // would have ~8 responses come back 500 with `error.code === "internal"`
    // at the default `MAX_MINT_ATTEMPTS = 5`.
    const non201 = responses.filter((r) => r.status !== 201);
    expect(non201).toEqual([]);

    // Belt-and-braces on the DB shape — every identityId is distinct, dense
    // h_0..h_N inclusive. The unique constraint (#215) would catch dupes
    // even if the retry budget were broken, so a future refactor that
    // bypasses the constraint (e.g. soft-deleting + re-inserting) still
    // trips this assert.
    const allHumans = await prisma.participant.findMany({
      where: { paneId: sid, kind: "human" },
      select: { identityId: true },
    });
    expect(allHumans).toHaveLength(N + 1); // +1 for h_0 from pane-create
    const identityIds = allHumans.map((p) => p.identityId).sort();
    expect(new Set(identityIds).size).toBe(identityIds.length);
    expect(identityIds).toEqual(
      Array.from({ length: N + 1 }, (_, i) => `h_${i}`).sort(),
    );
  });
});
