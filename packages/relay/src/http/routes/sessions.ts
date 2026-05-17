import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { artifactSchema, createSessionSchema } from "@pane/core";
import type { Config } from "../../config.js";
import { appendSystemEvent } from "../../core/events.js";
import {
  generateSessionId,
  generateToken,
  hashKey,
  keyPrefix,
} from "../../keys.js";
import { dualAuth, requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import { issueTicket, TICKET_TTL_MS } from "../../ws/ticket.js";
import {
  assertSchemaWithinLimits,
  invalidateSchemaCache,
  mergeSchemaAdditive,
  validateSchemaShape,
} from "../../core/validation.js";
import { assertSafeArtifactUrl, assertSafeWebhookUrl } from "../ssrf.js";
import { encryptSecret } from "../../crypto.js";
import { recordSessionCreated } from "../../telemetry/metrics.js";
import type { EventSchema } from "../../types.js";

const sessions = new Hono<AuthEnv>();

// `artifactSchema` and `createSessionSchema` (request shapes for POST/PATCH
// /v1/sessions) are the single source of truth in @pane/core/schemas — the
// relay imports them so the server-side validator and the client-facing
// types can never drift. See packages/core/src/schemas.ts.

function publicWsUrl(config: Config): string {
  const u = new URL(config.publicUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/$/, "");
}

sessions.post("/", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const body = await c.req.json().catch(() => null);
  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }

  const { artifact, participants, ttl, metadata, callback } = parsed.data;

  if (Buffer.byteLength(artifact.source, "utf8") > config.MAX_ARTIFACT_BYTES) {
    throw errors.payloadTooLarge();
  }
  if (artifact.type === "html-ref") {
    // Same SSRF surface as webhook.url: the relay (or, in phase 3+, the shell
    // page) will fetch this on the human's behalf. Block private/loopback/
    // metadata/CGNAT targets up front.
    await assertSafeArtifactUrl(artifact.source);
  }

  const requestedHumans = participants?.humans ?? 1;
  if (requestedHumans > config.MAX_PARTICIPANTS_PER_SESSION) {
    throw errors.invalidRequest(
      `participants.humans must be <= ${config.MAX_PARTICIPANTS_PER_SESSION}`,
    );
  }

  if (callback) {
    await assertSafeWebhookUrl(callback.url);
  }

  assertSchemaWithinLimits(parsed.data.schema, {
    maxBytes: config.MAX_SCHEMA_BYTES,
    maxDepth: config.MAX_SCHEMA_DEPTH,
  });
  const eventSchema: EventSchema = validateSchemaShape(parsed.data.schema);

  const ttlSeconds = Math.min(
    Math.max(1, ttl ?? config.DEFAULT_TTL_SECONDS),
    config.MAX_TTL_SECONDS,
  );
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const agent = c.get("agent");

  // Per-agent session cap: bound how many open sessions a single agent can
  // hold so a compromised/abusive key cannot exhaust storage. Closed/expired
  // sessions do not count — they are reclaimed by the TTL sweeper.
  // This is a count-then-create check, so it is a SOFT cap — concurrent
  // POST /v1/sessions from one agent can race past it and overshoot by
  // roughly the number of inflight requests. Acceptable: the cap bounds
  // abuse to ~N, not an exact count, and the limit is deliberately generous.
  if (config.MAX_SESSIONS_PER_AGENT > 0) {
    const openCount = await prisma.session.count({
      where: { agentId: agent.id, status: "open" },
    });
    if (openCount >= config.MAX_SESSIONS_PER_AGENT) {
      throw errors.tooManyRequests(
        `open session cap reached (max ${config.MAX_SESSIONS_PER_AGENT} per agent); close an existing session before creating a new one`,
      );
    }
  }

  const sessionId = generateSessionId();
  const humanTokens: string[] = Array.from({ length: requestedHumans }, () =>
    generateToken(),
  );
  const agentToken = generateToken();

  await prisma.session.create({
    data: {
      id: sessionId,
      agentId: agent.id,
      artifactType: artifact.type,
      artifactSource: artifact.source,
      eventSchema: eventSchema as unknown as Prisma.InputJsonValue,
      expiresAt,
      metadata: metadata
        ? (metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      callbackUrl: callback?.url ?? null,
      callbackSecretEnc: callback ? encryptSecret(callback.secret) : null,
      callbackFilter: callback?.events
        ? (callback.events as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      participants: {
        create: [
          {
            kind: "agent",
            identityId: agent.id,
            tokenHash: hashKey(agentToken),
            tokenPrefix: keyPrefix(agentToken),
          },
          ...humanTokens.map((t, i) => ({
            kind: "human" as const,
            identityId: `h_${i}`,
            tokenHash: hashKey(t),
            tokenPrefix: keyPrefix(t),
          })),
        ],
      },
    },
  });

  recordSessionCreated();

  const wsBase = publicWsUrl(config);
  return c.json(
    {
      session_id: sessionId,
      tokens: {
        humans: humanTokens,
        agent: agentToken,
      },
      urls: {
        humans: humanTokens.map((t) => `${config.publicUrl}/s/${t}`),
        agent_stream: `${wsBase}/v1/sessions/${sessionId}/stream`,
      },
      expires_at: expiresAt.toISOString(),
    },
    201,
  );
});

// Mint a short-lived, single-use WebSocket upgrade ticket.
//
// Browsers cannot set an Authorization header on `new WebSocket()`, so the WS
// URL must carry a credential as a query parameter — and a long-lived token
// there leaks into upstream proxy access logs. The browser flow is therefore:
// authenticate HERE with the real token, get a ticket, then open the WS with
// `?ticket=`. A leaked ticket is worthless (30s TTL, single-use, bound to one
// identity + session). See src/ws/ticket.ts and issue #8.
//
// Auth is DUAL — agent OR participant — exactly like the events endpoints: a
// participant holding a share-link token, or the owning agent, must both be
// able to mint a ticket for THEIR session. `dualAuth` already enforces that
// the `:id` path param matches the session the token authorizes (participant
// .sessionId === :id; agent owns the session).
sessions.post("/:id/ws-ticket", dualAuth, (c) => {
  const session = c.get("session");
  const author = c.get("author");
  if (session.status !== "open" || session.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }
  const ticket = issueTicket(author, session.id);
  return c.json(
    {
      ticket,
      expires_at: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
    },
    201,
  );
});

sessions.get("/:id", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  const me = c.get("agent");
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.agentId !== me.id) throw errors.notFound();
  const isExpired = session.expiresAt.getTime() < Date.now();
  return c.json({
    session_id: session.id,
    status: isExpired ? "closed" : session.status,
    schema_version: session.schemaVersion,
    artifact_version: session.artifactVersion,
    metadata: session.metadata,
    created_at: session.createdAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
  });
});

const patchSchemaBody = z.object({
  add: z.object({ events: z.record(z.unknown()) }),
});

sessions.patch("/:id/schema", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const id = c.req.param("id");
  const me = c.get("agent");
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.agentId !== me.id) throw errors.notFound();
  if (session.status !== "open") throw errors.gone();

  const body = await c.req.json().catch(() => null);
  const parsed = patchSchemaBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }

  assertSchemaWithinLimits(parsed.data.add, {
    maxBytes: config.MAX_SCHEMA_BYTES,
    maxDepth: config.MAX_SCHEMA_DEPTH,
  });
  const current = session.eventSchema as unknown as EventSchema;
  const merged = mergeSchemaAdditive(current, parsed.data.add);
  const added = Object.keys(parsed.data.add.events).filter(
    (t) => !current.events[t],
  );
  const updated = await prisma.session.update({
    where: { id },
    data: {
      eventSchema: merged as unknown as Prisma.InputJsonValue,
      schemaVersion: { increment: 1 },
    },
  });
  invalidateSchemaCache(id);
  await appendSystemEvent(prisma, id, "system.schema.updated", {
    version: updated.schemaVersion,
    added,
  });
  return c.json({ schema_version: updated.schemaVersion });
});

const patchArtifactBody = z.object({ artifact: artifactSchema });

sessions.patch("/:id/artifact", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const id = c.req.param("id");
  const me = c.get("agent");
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.agentId !== me.id) throw errors.notFound();
  if (session.status !== "open") throw errors.gone();

  const body = await c.req.json().catch(() => null);
  const parsed = patchArtifactBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }
  const a = parsed.data.artifact;
  if (Buffer.byteLength(a.source, "utf8") > config.MAX_ARTIFACT_BYTES) {
    throw errors.payloadTooLarge();
  }

  const updated = await prisma.session.update({
    where: { id },
    data: {
      artifactType: a.type,
      artifactSource: a.source,
      artifactVersion: { increment: 1 },
    },
  });
  await appendSystemEvent(prisma, id, "system.artifact.updated", {
    version: updated.artifactVersion,
    type: updated.artifactType,
  });
  return c.json({ artifact_version: updated.artifactVersion });
});

sessions.delete("/:id", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  const me = c.get("agent");
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.agentId !== me.id) throw errors.notFound();
  if (session.status === "closed") return c.body(null, 204);
  await prisma.session.update({
    where: { id },
    data: { status: "closed", expiresAt: new Date() },
  });
  invalidateSchemaCache(id);
  await appendSystemEvent(prisma, id, "system.session.expired", {});
  return c.body(null, 204);
});

export default sessions;
