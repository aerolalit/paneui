import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import config from "../../config.js";
import prisma from "../../db.js";
import { generateSessionId, generateToken, hashKey, keyPrefix } from "../../keys.js";
import { requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import {
  invalidateSchemaCache,
  mergeSchemaAdditive,
  validateSchemaShape,
} from "../../core/validation.js";
import { publish } from "../broadcast.js";
import { serializeEvent } from "../serialize.js";
import { assertSafeArtifactUrl, assertSafeWebhookUrl } from "../ssrf.js";
import { encryptSecret } from "../../crypto.js";
import type { EventSchema } from "../../types.js";

const sessions = new Hono<AuthEnv>();

const artifactSchema = z.object({
  type: z.enum(["html-inline", "html-ref"]),
  source: z.string().min(1),
});

const callbackSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  secret: z.string().min(8),
});

const createBody = z.object({
  artifact: artifactSchema,
  schema: z.unknown(),
  participants: z
    .object({ humans: z.number().int().positive() })
    .optional(),
  ttl: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
  callback: callbackSchema.optional(),
});

function publicWsUrl(): string {
  const u = new URL(config.publicUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/$/, "");
}

async function appendSystemEvent(
  sessionId: string,
  type: string,
  data: object,
): Promise<void> {
  const event = await prisma.event.create({
    data: {
      sessionId,
      authorKind: "system",
      authorId: "system",
      type,
      data: data as Prisma.InputJsonValue,
    },
  });
  publish(sessionId, serializeEvent(event));
}

sessions.post("/", requireAgent, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest("invalid body", parsed.error.flatten());
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

  const eventSchema: EventSchema = validateSchemaShape(parsed.data.schema);

  const ttlSeconds = Math.min(
    Math.max(1, ttl ?? config.DEFAULT_TTL_SECONDS),
    config.MAX_TTL_SECONDS,
  );
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const agent = c.get("agent");
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
      metadata: metadata ? (metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
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

  const wsBase = publicWsUrl();
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

sessions.get("/:id", requireAgent, async (c) => {
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

const patchSchemaBody = z.object({ add: z.object({ events: z.record(z.unknown()) }) });

sessions.patch("/:id/schema", requireAgent, async (c) => {
  const id = c.req.param("id");
  const me = c.get("agent");
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.agentId !== me.id) throw errors.notFound();
  if (session.status !== "open") throw errors.gone();

  const body = await c.req.json().catch(() => null);
  const parsed = patchSchemaBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest("invalid body", parsed.error.flatten());
  }

  const current = session.eventSchema as unknown as EventSchema;
  const merged = mergeSchemaAdditive(current, parsed.data.add);
  const added = Object.keys(parsed.data.add.events).filter((t) => !current.events[t]);
  const updated = await prisma.session.update({
    where: { id },
    data: {
      eventSchema: merged as unknown as Prisma.InputJsonValue,
      schemaVersion: { increment: 1 },
    },
  });
  invalidateSchemaCache(id);
  await appendSystemEvent(id, "system.schema.updated", { version: updated.schemaVersion, added });
  return c.json({ schema_version: updated.schemaVersion });
});

const patchArtifactBody = z.object({ artifact: artifactSchema });

sessions.patch("/:id/artifact", requireAgent, async (c) => {
  const id = c.req.param("id");
  const me = c.get("agent");
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.agentId !== me.id) throw errors.notFound();
  if (session.status !== "open") throw errors.gone();

  const body = await c.req.json().catch(() => null);
  const parsed = patchArtifactBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest("invalid body", parsed.error.flatten());
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
  await appendSystemEvent(id, "system.artifact.updated", {
    version: updated.artifactVersion,
    type: updated.artifactType,
  });
  return c.json({ artifact_version: updated.artifactVersion });
});

sessions.delete("/:id", requireAgent, async (c) => {
  const id = c.req.param("id");
  const me = c.get("agent");
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session || session.agentId !== me.id) throw errors.notFound();
  if (session.status === "closed") return c.body(null, 204);
  await prisma.session.update({
    where: { id },
    data: { status: "closed", expiresAt: new Date() },
  });
  // TODO(phase-4): the TTL sweeper should call invalidateSchemaCache too — the
  // Ajv compiled-schema cache is otherwise unbounded for sessions that expire
  // without an explicit DELETE.
  invalidateSchemaCache(id);
  await appendSystemEvent(id, "system.session.expired", {});
  return c.body(null, 204);
});

export default sessions;
