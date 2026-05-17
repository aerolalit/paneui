// End-to-end test for the HTTP transport: drives requests through the real
// Hono app (auth middleware → routes → writeEvent → DB). DB engine follows
// DATABASE_URL (sqlite file or postgres) — CI matrix runs both.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { PrismaClient } from "@prisma/client";
import { setupTestDb, type TestDb } from "../test-helpers/db.js";
import { createPrismaClient } from "../db.js";
import { loadConfig } from "../config.js";
import { hashKey, keyPrefix } from "../keys.js";
import { buildApp } from "./app.js";

let testDb: TestDb;
let app: Hono;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await setupTestDb();
  process.env.DATABASE_URL = testDb.dbUrl;
  process.env.LOG_LEVEL = "error";
  process.env.PANE_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.PUBLIC_URL = "http://localhost:3000";

  // Inject the Prisma client + config directly — no module singleton, no
  // `delete globalThis.prisma` dance, no dynamic imports.
  prisma = createPrismaClient(testDb.dbUrl);
  await testDb.applyMigration(prisma);
  app = buildApp(loadConfig(), prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  await testDb.cleanup();
});

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
  const apiKey = "pane_" + randomBytes(16).toString("hex");
  const agent = await prisma.agent.create({
    data: {
      name: `agent-${randomBytes(4).toString("hex")}`,
      keyHash: hashKey(apiKey),
      keyPrefix: keyPrefix(apiKey),
    },
  });
  return { id: agent.id, apiKey };
}

function bearer(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

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

describe("HTTP e2e", () => {
  beforeEach(async () => {
    await testDb.truncateAll(prisma);
  });

  describe("session lifecycle", () => {
    it("POST /v1/sessions creates a session, returns 201 + tokens + urls", async () => {
      const { apiKey } = await seedAgent();
      const res = await app.fetch(
        new Request("http://t/v1/sessions", {
          method: "POST",
          headers: bearer(apiKey),
          body: JSON.stringify({
            artifact: { type: "html-inline", source: "<html></html>" },
            schema: minimalSchema,
            participants: { humans: 2 },
          }),
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        session_id: string;
        tokens: { humans: string[]; agent: string };
        urls: { humans: string[]; agent_stream: string };
        expires_at: string;
      };
      expect(body.session_id).toMatch(/^ses_/);
      expect(body.tokens.humans).toHaveLength(2);
      expect(body.tokens.agent).toBeTruthy();
      expect(body.urls.humans[0]).toContain("/s/");
      expect(body.urls.agent_stream).toContain("ws");
    });

    it("rejects an unauthenticated request with 401", async () => {
      const res = await app.fetch(
        new Request("http://t/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            artifact: { type: "html-inline", source: "<html></html>" },
            schema: minimalSchema,
          }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it("rejects an SSRF-style callback URL with 400 before any DB write", async () => {
      const { apiKey } = await seedAgent();
      const res = await app.fetch(
        new Request("http://t/v1/sessions", {
          method: "POST",
          headers: bearer(apiKey),
          body: JSON.stringify({
            artifact: { type: "html-inline", source: "<html></html>" },
            schema: minimalSchema,
            callback: {
              url: "http://169.254.169.254/latest/meta-data/",
              events: ["review.*"],
              secret: "whsec_topsecret",
            },
          }),
        }),
      );
      expect(res.status).toBe(400);
      const sessions = await prisma.session.findMany();
      expect(sessions).toHaveLength(0);
    });

    it("encrypts the callback secret at rest", async () => {
      const { apiKey } = await seedAgent();
      const create = await app.fetch(
        new Request("http://t/v1/sessions", {
          method: "POST",
          headers: bearer(apiKey),
          body: JSON.stringify({
            artifact: { type: "html-inline", source: "<html></html>" },
            schema: minimalSchema,
            callback: {
              url: "https://example.com/hook",
              events: ["review.*"],
              secret: "whsec_topsecret",
            },
          }),
        }),
      );
      expect(create.status).toBe(201);
      const row = await prisma.session.findFirst();
      expect(row?.callbackSecretEnc).not.toBeNull();
      expect(row?.callbackSecretEnc).not.toContain("topsecret");
      expect(row?.callbackSecretEnc!.startsWith("v1.")).toBe(true);
    });

    it("DELETE /v1/sessions/:id closes a session and a follow-up event fails as gone", async () => {
      const { apiKey } = await seedAgent();
      const create = await app.fetch(
        new Request("http://t/v1/sessions", {
          method: "POST",
          headers: bearer(apiKey),
          body: JSON.stringify({
            artifact: { type: "html-inline", source: "<html></html>" },
            schema: minimalSchema,
          }),
        }),
      );
      const { session_id, tokens } = (await create.json()) as {
        session_id: string;
        tokens: { agent: string };
      };
      const del = await app.fetch(
        new Request(`http://t/v1/sessions/${session_id}`, {
          method: "DELETE",
          headers: bearer(apiKey),
        }),
      );
      expect(del.status).toBe(204);

      const emit = await app.fetch(
        new Request(`http://t/v1/sessions/${session_id}/events`, {
          method: "POST",
          headers: bearer(tokens.agent),
          body: JSON.stringify({
            type: "review.commentAdded",
            data: { body: "late" },
          }),
        }),
      );
      expect(emit.status).toBe(410);
    });
  });

  describe("events POST / GET round trip", () => {
    async function createOpenSession(apiKey: string): Promise<{
      sessionId: string;
      agentToken: string;
      humanToken: string;
    }> {
      const res = await app.fetch(
        new Request("http://t/v1/sessions", {
          method: "POST",
          headers: bearer(apiKey),
          body: JSON.stringify({
            artifact: { type: "html-inline", source: "<html></html>" },
            schema: minimalSchema,
            participants: { humans: 1 },
          }),
        }),
      );
      const body = (await res.json()) as {
        session_id: string;
        tokens: { humans: string[]; agent: string };
      };
      return {
        sessionId: body.session_id,
        agentToken: body.tokens.agent,
        humanToken: body.tokens.humans[0]!,
      };
    }

    it("agent posts an event, GET ?since= returns it", async () => {
      const { apiKey } = await seedAgent();
      const { sessionId, agentToken } = await createOpenSession(apiKey);

      const post = await app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}/events`, {
          method: "POST",
          headers: bearer(agentToken),
          body: JSON.stringify({
            type: "review.commentAdded",
            data: { body: "hi" },
          }),
        }),
      );
      expect(post.status).toBe(201);
      const postBody = (await post.json()) as {
        event: { id: string; type: string };
      };
      expect(postBody.event.type).toBe("review.commentAdded");

      const get = await app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}/events?since=0`, {
          headers: bearer(agentToken),
        }),
      );
      expect(get.status).toBe(200);
      const getBody = (await get.json()) as {
        events: { id: string; type: string }[];
        next_cursor: string | null;
      };
      expect(getBody.events).toHaveLength(1);
      expect(getBody.events[0]!.id).toBe(postBody.event.id);
      expect(getBody.next_cursor).toBe(postBody.event.id);
    });

    it("human can post via participant token; agent can read it back", async () => {
      const { apiKey } = await seedAgent();
      const { sessionId, agentToken, humanToken } =
        await createOpenSession(apiKey);

      const post = await app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}/events`, {
          method: "POST",
          headers: bearer(humanToken),
          body: JSON.stringify({
            type: "review.commentAdded",
            data: { body: "from human" },
          }),
        }),
      );
      expect(post.status).toBe(201);

      const get = await app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}/events?since=0`, {
          headers: bearer(agentToken),
        }),
      );
      const body = (await get.json()) as {
        events: { author: { kind: string }; data: { body: string } }[];
      };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]!.author.kind).toBe("human");
      expect(body.events[0]!.data.body).toBe("from human");
    });

    it("idempotency_key replay returns 200 + deduped:true", async () => {
      const { apiKey } = await seedAgent();
      const { sessionId, agentToken } = await createOpenSession(apiKey);
      const key = "idem-" + randomBytes(6).toString("hex");
      const send = () =>
        app.fetch(
          new Request(`http://t/v1/sessions/${sessionId}/events`, {
            method: "POST",
            headers: bearer(agentToken),
            body: JSON.stringify({
              type: "review.commentAdded",
              data: { body: "x" },
              idempotency_key: key,
            }),
          }),
        );
      const a = await send();
      const b = await send();
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      const bBody = (await b.json()) as { deduped: boolean };
      expect(bBody.deduped).toBe(true);
    });

    it("schema-violating payload returns 422", async () => {
      const { apiKey } = await seedAgent();
      const { sessionId, agentToken } = await createOpenSession(apiKey);
      const res = await app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}/events`, {
          method: "POST",
          headers: bearer(agentToken),
          body: JSON.stringify({
            type: "review.commentAdded",
            data: { wrongField: 1 },
          }),
        }),
      );
      expect(res.status).toBe(422);
    });

    it("long-poll delivers an event posted concurrently with the query window (#49)", async () => {
      const { apiKey } = await seedAgent();
      const { sessionId, agentToken, humanToken } =
        await createOpenSession(apiKey);

      // Start a long-poll GET with an empty event log. The handler subscribes
      // to the broadcast bus before its first query, so an event published
      // while the request is in flight must still land in the same response.
      const get = app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}/events?since=0&wait=5`, {
          headers: bearer(agentToken),
        }),
      );

      // Race the publish against the query window: post immediately, no delay.
      const post = await app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}/events`, {
          method: "POST",
          headers: bearer(humanToken),
          body: JSON.stringify({
            type: "review.commentAdded",
            data: { body: "raced" },
          }),
        }),
      );
      expect(post.status).toBe(201);
      const postBody = (await post.json()) as { event: { id: string } };

      const res = await get;
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        events: { id: string; data: { body: string } }[];
        next_cursor: string | null;
      };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]!.id).toBe(postBody.event.id);
      expect(body.events[0]!.data.body).toBe("raced");
    });

    it("wrong-session participant token returns 404", async () => {
      const { apiKey } = await seedAgent();
      const a = await createOpenSession(apiKey);
      const b = await createOpenSession(apiKey);
      // Use b's human token against a's session.
      const res = await app.fetch(
        new Request(`http://t/v1/sessions/${a.sessionId}/events?since=0`, {
          headers: bearer(b.humanToken),
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("agent-friendly error fields", () => {
    interface ErrBody {
      error: {
        code: string;
        message: string;
        hint?: string;
        retryable?: boolean;
        docs_url?: string;
        details?: unknown;
      };
    }

    async function openSession(apiKey: string): Promise<{
      sessionId: string;
      agentToken: string;
    }> {
      const res = await app.fetch(
        new Request("http://t/v1/sessions", {
          method: "POST",
          headers: bearer(apiKey),
          body: JSON.stringify({
            artifact: { type: "html-inline", source: "<html></html>" },
            schema: minimalSchema,
            participants: { humans: 1 },
          }),
        }),
      );
      const body = (await res.json()) as {
        session_id: string;
        tokens: { agent: string };
      };
      return { sessionId: body.session_id, agentToken: body.tokens.agent };
    }

    it("401 is not retryable and carries a hint + docs_url", async () => {
      const res = await app.fetch(
        new Request("http://t/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            artifact: { type: "html-inline", source: "<html></html>" },
            schema: minimalSchema,
          }),
        }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrBody;
      expect(body.error.code).toBe("unauthorized");
      expect(body.error.retryable).toBe(false);
      expect(body.error.hint).toMatch(/bearer token/i);
      expect(body.error.docs_url).toContain("docs/SPEC.md#");
    });

    it("404 is not retryable and has a hint", async () => {
      const { apiKey } = await seedAgent();
      const res = await app.fetch(
        new Request("http://t/v1/sessions/ses_does_not_exist", {
          headers: bearer(apiKey),
        }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrBody;
      expect(body.error.code).toBe("not_found");
      expect(body.error.retryable).toBe(false);
      expect(body.error.hint).toBeTruthy();
    });

    it("422 schema violation carries a specific hint", async () => {
      const { apiKey } = await seedAgent();
      const { sessionId, agentToken } = await openSession(apiKey);
      const res = await app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}/events`, {
          method: "POST",
          headers: bearer(agentToken),
          body: JSON.stringify({
            type: "review.commentAdded",
            data: { wrongField: 1 },
          }),
        }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as ErrBody;
      expect(body.error.code).toBe("schema_violation");
      expect(body.error.retryable).toBe(false);
      expect(body.error.hint).toMatch(/review\.commentAdded/);
      expect(body.error.docs_url).toContain("docs/SPEC.md#");
    });

    it("422 unknown event type names the offending type in the hint", async () => {
      const { apiKey } = await seedAgent();
      const { sessionId, agentToken } = await openSession(apiKey);
      const res = await app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}/events`, {
          method: "POST",
          headers: bearer(agentToken),
          body: JSON.stringify({ type: "not.declared", data: {} }),
        }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as ErrBody;
      expect(body.error.code).toBe("unknown_event_type");
      expect(body.error.hint).toMatch(/not\.declared/);
    });

    it("410 gone explains the session is closed and not retryable", async () => {
      const { apiKey } = await seedAgent();
      const { sessionId, agentToken } = await openSession(apiKey);
      await app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}`, {
          method: "DELETE",
          headers: bearer(apiKey),
        }),
      );
      const res = await app.fetch(
        new Request(`http://t/v1/sessions/${sessionId}/events`, {
          method: "POST",
          headers: bearer(agentToken),
          body: JSON.stringify({
            type: "review.commentAdded",
            data: { body: "hi" },
          }),
        }),
      );
      expect(res.status).toBe(410);
      const body = (await res.json()) as ErrBody;
      expect(body.error.code).toBe("gone");
      expect(body.error.retryable).toBe(false);
      expect(body.error.hint).toMatch(/closed|expired/i);
    });

    it("400 invalid body keeps Zod details and gains a hint", async () => {
      const { apiKey } = await seedAgent();
      const res = await app.fetch(
        new Request("http://t/v1/sessions", {
          method: "POST",
          headers: bearer(apiKey),
          body: JSON.stringify({ artifact: { type: "bogus" } }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrBody;
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.retryable).toBe(false);
      expect(body.error.hint).toBeTruthy();
      expect(body.error.details).toBeTruthy();
    });
  });
});
