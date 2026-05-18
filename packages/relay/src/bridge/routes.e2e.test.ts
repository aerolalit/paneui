// End-to-end test for the bridge routes — exercises the /presence endpoint
// (polled by the shell to keep the agent-presence pill fresh) through the
// real Hono app. DB engine follows DATABASE_URL (sqlite or postgres).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";
import { loadConfig } from "../config.js";
import { hashKey, keyPrefix, generateHumanParticipantToken } from "../keys.js";
import { buildApp } from "../http/app.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(loadConfig(), prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

const minimalSchema = {
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
};

// Seed an agent + session + one human participant, returning the
// participant token (the bridge URL credential) and the agent id.
async function seedSession(opts?: {
  agentLastUsedAt?: Date;
  closed?: boolean;
  expired?: boolean;
  artifactSource?: string;
}): Promise<{
  token: string;
  agentId: string;
  sessionId: string;
}> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
      lastUsedAt: opts?.agentLastUsedAt ?? null,
    },
  });
  const sessionId = "ses_" + randomBytes(8).toString("hex");
  await prisma.session.create({
    data: {
      id: sessionId,
      agentId: agent.id,
      artifactType: "html-inline",
      artifactSource: opts?.artifactSource ?? "<html></html>",
      eventSchema: minimalSchema,
      status: opts?.closed ? "closed" : "open",
      expiresAt: opts?.expired
        ? new Date(Date.now() - 60 * 60 * 1000)
        : new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const token = generateHumanParticipantToken();
  await prisma.participant.create({
    data: {
      sessionId,
      kind: "human",
      identityId: "human-1",
      tokenHash: hashKey(token),
      tokenPrefix: keyPrefix(token),
    },
  });
  return { token, agentId: agent.id, sessionId };
}

describe("bridge /presence", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns the three presence fields as JSON", async () => {
    const usedAt = new Date(Date.now() - 5000);
    const { token } = await seedSession({ agentLastUsedAt: usedAt });

    const res = await app.fetch(new Request(`http://t/s/${token}/presence`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      agentLive: boolean;
      agentLastEventAt: string | null;
      agentLastUsedAt: string | null;
    };
    expect(body.agentLive).toBe(false);
    expect(body.agentLastEventAt).toBeNull();
    expect(body.agentLastUsedAt).toBe(usedAt.toISOString());
  });

  it("reports agentLastEventAt from the most recent agent-authored event", async () => {
    const { token, sessionId } = await seedSession();
    await prisma.event.create({
      data: {
        sessionId,
        authorKind: "agent",
        authorId: "agent-x",
        type: "review.commentAdded",
        data: { body: "hi" },
      },
    });

    const res = await app.fetch(new Request(`http://t/s/${token}/presence`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentLastEventAt: string | null };
    expect(body.agentLastEventAt).not.toBeNull();
  });

  it("404s on a bad token", async () => {
    const res = await app.fetch(
      new Request("http://t/s/not-a-real-token/presence"),
    );
    expect(res.status).toBe(404);
  });

  it("404s on a well-formed but unknown token", async () => {
    // Valid `tok_h_`-shaped token that passes TOKEN_RX but is not seeded —
    // exercises the DB-miss path rather than the regex-reject path.
    const bogus = generateHumanParticipantToken();
    const res = await app.fetch(new Request(`http://t/s/${bogus}/presence`));
    expect(res.status).toBe(404);
  });
});

describe("bridge shell GET /s/:token", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  it("returns 200 text/html for a valid open session", async () => {
    const { token } = await seedSession();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("sets the framing/caching security headers", async () => {
    const { token } = await seedSession();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("sets a nonce-based CSP that confines scripts and connections", async () => {
    const { token } = await seedSession();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it("sets a permissions-policy that disables sensitive APIs", async () => {
    const { token } = await seedSession();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const pp = res.headers.get("permissions-policy") ?? "";
    expect(pp).toContain("camera=()");
    expect(pp).toContain("geolocation=()");
  });

  it("inlines the pane-cfg JSON block carrying the participant token", async () => {
    const { token } = await seedSession();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    expect(body).toContain('<script type="application/json" id="pane-cfg">');
    expect(body).toContain(token);
  });

  it("renders an iframe pointing at the content route", async () => {
    const { token } = await seedSession();
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    const body = await res.text();
    expect(body).toContain("<iframe");
    expect(body).toContain(`src="/s/${token}/content"`);
  });

  it("renders the closed banner and no iframe for a closed session", async () => {
    const { token } = await seedSession({ closed: true });
    const res = await app.fetch(new Request(`http://t/s/${token}`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('class="closed"');
    expect(body).toContain("This session is closed");
    expect(body).not.toContain("<iframe");
  });

  it("404s on a malformed token", async () => {
    const res = await app.fetch(new Request("http://t/s/not-a-real-token"));
    expect(res.status).toBe(404);
  });

  it("404s on a well-formed but unknown token", async () => {
    const bogus = generateHumanParticipantToken();
    const res = await app.fetch(new Request(`http://t/s/${bogus}`));
    expect(res.status).toBe(404);
  });
});

describe("bridge content GET /s/:token/content", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  const MARKER = '<div id="art">MARKER</div>';

  it("returns 200 text/html for a valid open session", async () => {
    const { token } = await seedSession({ artifactSource: MARKER });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("sets a sandboxed CSP for the artifact frame", async () => {
    const { token } = await seedSession({ artifactSource: MARKER });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("embeds the artifact body and the pane shim", async () => {
    const { token } = await seedSession({ artifactSource: MARKER });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    const body = await res.text();
    expect(body).toContain(MARKER);
    // Stable substrings from shim.client.ts: it assigns `window.pane`
    // and tags every frame with `__pane`.
    expect(body).toContain("window.pane");
    expect(body).toContain("__pane");
  });

  it("does not set X-Frame-Options (unlike the shell route)", async () => {
    const { token } = await seedSession({ artifactSource: MARKER });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("returns 410 for a closed session", async () => {
    const { token } = await seedSession({ closed: true });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    expect(res.status).toBe(410);
  });

  it("returns 410 for an expired session", async () => {
    const { token } = await seedSession({ expired: true });
    const res = await app.fetch(new Request(`http://t/s/${token}/content`));
    expect(res.status).toBe(410);
  });

  it("404s on a malformed token", async () => {
    const res = await app.fetch(
      new Request("http://t/s/not-a-real-token/content"),
    );
    expect(res.status).toBe(404);
  });
});
