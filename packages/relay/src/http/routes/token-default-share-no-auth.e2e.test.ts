// Regression test pinning the load-bearing share-link guarantee:
//
//   A pane's DEFAULT share — the `/s/<token>` link an agent hands a human —
//   must serve the pane shell IMMEDIATELY, with NO login / cookie / auth.
//
// The identity-sharing feature (`accessMode` invite_only|link|public +
// invitation grants + `/p/:paneId`) layered a *second*, identity-gated way to
// view a pane on top of this. That feature must NOT regress the original
// capability-token path: the token in the URL IS the credential, independent
// of the pane's /p access mode (accessMode never gates /s/<token>).
//
// This test drives the real create flow (`POST /v1/panes`) end-to-end so it
// also pins the *shape* of the handed-over link (`<publicUrl>/s/<token>`),
// then fetches `/s/:token` with no cookie and no Authorization header and
// asserts it serves the shell with HTTP 200 — not a login redirect, not 404.

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

const PUBLIC_URL = "http://localhost:3000";

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");

  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(
    loadConfig({
      DATABASE_URL: testDb.dbUrl,
      PUBLIC_URL,
    }),
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
    ping: { payload: { type: "object" }, emittedBy: ["page", "agent"] },
  },
};

interface CreateResponse {
  pane_id: string;
  tokens: { humans: string[] };
  urls: { humans: string[] };
}

// Create a pane the way an agent does — no participant overrides, so the
// relay mints exactly one default human share. Returns the create payload.
async function createPane(apiKey: string): Promise<CreateResponse> {
  const res = await app.fetch(
    new Request("http://t/v1/panes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        template: {
          name: "Test template",
          type: "html-inline",
          source: "<p>hello from the test template</p>",
          event_schema: eventSchema,
        },
        title: "Test pane",
      }),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as CreateResponse;
}

describe("default /s/<token> share serves immediately with no auth", () => {
  it("POST /v1/panes hands back a token-based /s/<token> human URL", async () => {
    const apiKey = await seedAgent();
    const body = await createPane(apiKey);

    // The default handed-over link is token-based. Assert both the bare
    // token and the absolute URL of the form <publicUrl>/s/<token>.
    expect(body.tokens.humans).toHaveLength(1);
    const token = body.tokens.humans[0]!;
    expect(token).toBeTruthy();

    expect(body.urls.humans).toHaveLength(1);
    expect(body.urls.humans[0]).toBe(`${PUBLIC_URL}/s/${token}`);

    // The path shape is exactly /s/<token> — nothing else (no query, no
    // extra segments) is required to view the pane.
    expect(new URL(body.urls.humans[0]!).pathname).toBe(`/s/${token}`);
  });

  it("GET /s/:token serves the shell with HTTP 200 and NO cookie / NO Authorization", async () => {
    const apiKey = await seedAgent();
    const { tokens } = await createPane(apiKey);
    const token = tokens.humans[0]!;

    // The request a human's browser makes when it first opens the link:
    // bare GET, no Cookie header, no Authorization header.
    const res = await app.fetch(new Request(`http://t/s/${token}`));

    // Immediate view — 200, not a 302 login redirect, not a 404.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    // The body is the viewer shell, not an error/login page: it carries the
    // pane-cfg block + the participant token and frames the content route.
    const html = await res.text();
    expect(html).toContain('<script type="application/json" id="pane-cfg">');
    expect(html).toContain(token);
    expect(html).toContain(`src="/s/${token}/content"`);
  });

  it("the token path 200s regardless of accessMode — the token link is independent of the /p access mode", async () => {
    const apiKey = await seedAgent();
    const { pane_id, tokens } = await createPane(apiKey);
    const token = tokens.humans[0]!;

    // Sanity: a freshly created pane defaults to `link`. The token-share
    // guarantee (rule 1) must hold for exactly this case.
    const fresh = await prisma.pane.findUniqueOrThrow({
      where: { id: pane_id },
      select: { accessMode: true },
    });
    expect(fresh.accessMode).toBe("link");

    // Default pane: /s/<token> still serves the shell with no auth.
    expect((await app.fetch(new Request(`http://t/s/${token}`))).status).toBe(
      200,
    );

    // Cycle through ALL three modes — including invite_only, the most
    // restrictive — and assert the capability-token path is unaffected. The
    // token IS the credential; accessMode never gates /s/<token>.
    for (const accessMode of ["public", "link", "invite_only"] as const) {
      await prisma.pane.update({
        where: { id: pane_id },
        data: { accessMode },
      });
      const res = await app.fetch(new Request(`http://t/s/${token}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });
});
