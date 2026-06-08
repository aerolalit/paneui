// End-to-end tests for the human-authed (owner-shell Share dialog) sharing
// surface on /v1/my-panes:
//   GET    /v1/my-panes/:id/grants        list grants + visibility
//   POST   /v1/my-panes/:id/grants        invite by email (default participant)
//   DELETE /v1/my-panes/:id/grants/:gid   revoke a grant
//   PATCH  /v1/my-panes/:id/visibility    flip restricted ↔ public
//   POST   /v1/my-panes/:id/share-link    mint a /s/<token> share link
//
// Authz: owner-only (ownerHumanId === human.id), 404 (not 403) for a
// non-owner/missing pane — no existence oracle. CSRF Origin/Referer enforced on
// the mutations (the /v1/my-panes/* mount). All DB ops are shared with the
// agent-authed /v1/panes surface (#436) via pane-sharing-service.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../../test-helpers/db.js";
import { createPrismaClient } from "../../db.js";
import { loadConfig } from "../../config.js";
import { buildApp } from "../app.js";
import {
  generateLoginCookie,
  hashLoginCookie,
  LOGIN_COOKIE_NAME,
} from "../../auth/cookie.js";

let testDb: TestDb;
let prisma: PrismaClient;
let app: Hono;

const SELF_ORIGIN = "http://localhost:3000";

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(
    loadConfig({ DATABASE_URL: testDb.dbUrl, PUBLIC_URL: SELF_ORIGIN }),
    prisma,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

beforeEach(async () => {
  await testDb.truncateAll(prisma);
});

async function seedLoggedInHuman(email = "alice@example.com"): Promise<{
  humanId: string;
  cookie: string;
}> {
  const human = await prisma.human.create({
    data: { email, verifiedAt: new Date() },
  });
  const cookie = generateLoginCookie();
  await prisma.login.create({
    data: {
      humanId: human.id,
      cookieHash: hashLoginCookie(cookie),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { humanId: human.id, cookie };
}

async function seedOwnedPane(humanId: string): Promise<string> {
  const agent = await prisma.agent.create({
    data: {
      name: "claimed",
      keyHash: randomBytes(32).toString("hex"),
      keyPrefix: randomBytes(4).toString("hex"),
      ownerHumanId: humanId,
      claimedAt: new Date(),
    },
  });
  const tmpl = await prisma.template.create({
    data: { ownerId: agent.id, name: "t" },
  });
  const tv = await prisma.templateVersion.create({
    data: {
      templateId: tmpl.id,
      version: 1,
      templateType: "html-inline",
      templateSource: "<p>hi</p>",
    },
  });
  const pane = await prisma.pane.create({
    data: {
      id: `pan_${randomBytes(6).toString("hex")}`,
      agentId: agent.id,
      ownerHumanId: humanId,
      templateVersionId: tv.id,
      title: "test",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  return pane.id;
}

function cookieHeader(cookie: string): Record<string, string> {
  return { cookie: `${LOGIN_COOKIE_NAME}=${cookie}` };
}

// Same-origin headers for a mutation that should pass the CSRF check.
function mutationHeaders(cookie: string): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: SELF_ORIGIN,
    ...cookieHeader(cookie),
  };
}

describe("GET /v1/my-panes/:id/grants", () => {
  it("requires a login cookie (401)", async () => {
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/pan_x/grants`),
    );
    expect(res.status).toBe(401);
  });

  it("returns visibility + grants for an owned pane", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants`, {
        headers: cookieHeader(cookie),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pane_id: string;
      access_mode: string;
      items: unknown[];
    };
    expect(body.pane_id).toBe(paneId);
    expect(body.access_mode).toBe("link");
    expect(body.items).toEqual([]);
  });

  it("404s a non-owner (no oracle)", async () => {
    const owner = await seedLoggedInHuman("owner@example.com");
    const paneId = await seedOwnedPane(owner.humanId);
    const other = await seedLoggedInHuman("eve@example.com");
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants`, {
        headers: cookieHeader(other.cookie),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/my-panes/:id/grants", () => {
  it("adds a grant defaulting to role participant", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants`, {
        method: "POST",
        headers: mutationHeaders(cookie),
        body: JSON.stringify({ email: "  Bob@Example.COM  " }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      invite_email: string;
      role: string;
    };
    expect(body.invite_email).toBe("bob@example.com");
    expect(body.role).toBe("participant");

    const grant = await prisma.paneGrant.findUnique({
      where: { id: body.id },
    });
    expect(grant?.paneId).toBe(paneId);
    expect(grant?.role).toBe("participant");
  });

  it("honors an explicit viewer role", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants`, {
        method: "POST",
        headers: mutationHeaders(cookie),
        body: JSON.stringify({ email: "viewer@example.com", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("viewer");
  });

  it("rejects a malformed email (400)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants`, {
        method: "POST",
        headers: mutationHeaders(cookie),
        body: JSON.stringify({ email: "nope" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404s a non-owner (no oracle)", async () => {
    const owner = await seedLoggedInHuman("owner@example.com");
    const paneId = await seedOwnedPane(owner.humanId);
    const other = await seedLoggedInHuman("eve@example.com");
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants`, {
        method: "POST",
        headers: mutationHeaders(other.cookie),
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a cross-origin POST (CSRF, 403)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example.com",
          ...cookieHeader(cookie),
        },
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("csrf_origin_mismatch");
  });
});

describe("DELETE /v1/my-panes/:id/grants/:gid", () => {
  it("revokes a grant the owner created", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const created = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants`, {
        method: "POST",
        headers: mutationHeaders(cookie),
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
    );
    const { id: gid } = (await created.json()) as { id: string };

    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants/${gid}`, {
        method: "DELETE",
        headers: mutationHeaders(cookie),
      }),
    );
    expect(res.status).toBe(204);
    const after = await prisma.paneGrant.findUnique({ where: { id: gid } });
    expect(after).toBeNull();
  });

  it("is idempotent on a missing grant (204)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants/grnt_missing`, {
        method: "DELETE",
        headers: mutationHeaders(cookie),
      }),
    );
    expect(res.status).toBe(204);
  });

  it("404s a non-owner (no oracle)", async () => {
    const owner = await seedLoggedInHuman("owner@example.com");
    const paneId = await seedOwnedPane(owner.humanId);
    const other = await seedLoggedInHuman("eve@example.com");
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/grants/grnt_x`, {
        method: "DELETE",
        headers: mutationHeaders(other.cookie),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/my-panes/:id/visibility", () => {
  it("sets the pane to public, invite_only, and link", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);

    for (const mode of ["public", "invite_only", "link"] as const) {
      const res = await app.fetch(
        new Request(`http://t/v1/my-panes/${paneId}/visibility`, {
          method: "PATCH",
          headers: mutationHeaders(cookie),
          body: JSON.stringify({ access_mode: mode }),
        }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as { access_mode: string }).toMatchObject({
        access_mode: mode,
      });
      expect(
        (await prisma.pane.findUnique({ where: { id: paneId } }))?.accessMode,
      ).toBe(mode);
    }
  });

  it("rejects an invalid access_mode (400)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/visibility`, {
        method: "PATCH",
        headers: mutationHeaders(cookie),
        body: JSON.stringify({ access_mode: "everyone" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404s a non-owner (no oracle)", async () => {
    const owner = await seedLoggedInHuman("owner@example.com");
    const paneId = await seedOwnedPane(owner.humanId);
    const other = await seedLoggedInHuman("eve@example.com");
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/visibility`, {
        method: "PATCH",
        headers: mutationHeaders(other.cookie),
        body: JSON.stringify({ access_mode: "public" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a cross-origin PATCH (CSRF, 403)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/visibility`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example.com",
          ...cookieHeader(cookie),
        },
        body: JSON.stringify({ access_mode: "public" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/my-panes/:id/share-link", () => {
  it("mints an anonymous /s/<token> share link", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/share-link`, {
        method: "POST",
        headers: mutationHeaders(cookie),
        body: "{}",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      participant_id: string;
      token: string;
      url: string;
    };
    expect(body.token).toMatch(/^tok_h_/);
    expect(body.url).toContain("/s/");

    const participant = await prisma.participant.findUnique({
      where: { id: body.participant_id },
    });
    expect(participant?.paneId).toBe(paneId);
    expect(participant?.kind).toBe("human");
    expect(participant?.humanId).toBeNull(); // anonymous capability link
  });

  it("404s a non-owner (no oracle)", async () => {
    const owner = await seedLoggedInHuman("owner@example.com");
    const paneId = await seedOwnedPane(owner.humanId);
    const other = await seedLoggedInHuman("eve@example.com");
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/share-link`, {
        method: "POST",
        headers: mutationHeaders(other.cookie),
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/my-panes/:id/tags (owner edits)", () => {
  it("401s without a cookie", async () => {
    const res = await app.fetch(
      new Request("http://t/v1/my-panes/pan_x/tags", {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: SELF_ORIGIN },
        body: JSON.stringify({ tags: ["x"] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("sets the pane's tags (trimmed + deduped), returns them", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/tags`, {
        method: "PATCH",
        headers: mutationHeaders(cookie),
        body: JSON.stringify({ tags: ["  livia  ", "pr-review", "livia"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(["livia", "pr-review"]);
    const row = await prisma.pane.findUnique({ where: { id: paneId } });
    expect(row!.tags).toEqual(["livia", "pr-review"]);
  });

  it("rejects the reserved 'favorite'/'favorites' tags (400)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    for (const reserved of ["favorite", "Favorites"]) {
      const res = await app.fetch(
        new Request(`http://t/v1/my-panes/${paneId}/tags`, {
          method: "PATCH",
          headers: mutationHeaders(cookie),
          body: JSON.stringify({ tags: [reserved] }),
        }),
      );
      expect(res.status).toBe(400);
    }
  });

  it("rejects > 20 tags or an over-long tag (400)", async () => {
    const { humanId, cookie } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const tooMany = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/tags`, {
        method: "PATCH",
        headers: mutationHeaders(cookie),
        body: JSON.stringify({
          tags: Array.from({ length: 21 }, (_, i) => "t" + i),
        }),
      }),
    );
    expect(tooMany.status).toBe(400);
    const tooLong = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/tags`, {
        method: "PATCH",
        headers: mutationHeaders(cookie),
        body: JSON.stringify({ tags: ["x".repeat(51)] }),
      }),
    );
    expect(tooLong.status).toBe(400);
  });

  it("404s for a pane the human doesn't own (no oracle)", async () => {
    const stranger = await seedLoggedInHuman("bob@example.com");
    const { humanId } = await seedLoggedInHuman();
    const paneId = await seedOwnedPane(humanId);
    const res = await app.fetch(
      new Request(`http://t/v1/my-panes/${paneId}/tags`, {
        method: "PATCH",
        headers: mutationHeaders(stranger.cookie),
        body: JSON.stringify({ tags: ["mine-now"] }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
