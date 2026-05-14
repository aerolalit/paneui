import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import config from "../../config.js";
import prisma from "../../db.js";
import { log } from "../../log.js";
import { dualAuth, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import { publish, waitForEvent } from "../broadcast.js";
import { serializeEvent } from "../serialize.js";
import { validateEvent } from "../validation.js";
import { fire, shouldFire } from "../webhook.js";
import type { EventSchema } from "../../types.js";

const events = new Hono<AuthEnv>();

events.use("*", dualAuth);

const postBody = z.object({
  type: z.string().min(1).max(64),
  data: z.unknown(),
  causation_id: z.string().min(1).max(64).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
});

events.post("/", async (c) => {
  const session = c.get("session");
  const author = c.get("author");
  if (session.status !== "open" || session.expiresAt.getTime() < Date.now()) {
    throw errors.gone();
  }

  const body = await c.req.json().catch(() => null);
  const parsed = postBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest("invalid body", parsed.error.flatten());
  }
  const { type, data, causation_id, idempotency_key } = parsed.data;

  if (Buffer.byteLength(JSON.stringify(data ?? null), "utf8") > config.MAX_EVENT_DATA_BYTES) {
    throw errors.payloadTooLarge();
  }

  validateEvent({
    sessionId: session.id,
    schemaVersion: session.schemaVersion,
    schema: session.eventSchema as unknown as EventSchema,
    type,
    data,
    authorKind: author.kind,
  });

  if (idempotency_key) {
    const existing = await prisma.event.findUnique({
      where: {
        sessionId_authorId_idempotencyKey: {
          sessionId: session.id,
          authorId: author.id,
          idempotencyKey: idempotency_key,
        },
      },
    });
    if (existing) {
      return c.json({ event: serializeEvent(existing), deduped: true }, 200);
    }
  }

  const event = await prisma.event.create({
    data: {
      sessionId: session.id,
      authorKind: author.kind,
      authorId: author.id,
      type,
      data: (data ?? null) as Prisma.InputJsonValue,
      causationId: causation_id ?? null,
      idempotencyKey: idempotency_key ?? null,
    },
  });
  const serialized = serializeEvent(event);
  publish(session.id, serialized);

  if (
    session.callbackUrl &&
    session.callbackSecretEnc &&
    shouldFire(type, session.callbackFilter as string[] | null)
  ) {
    fire(
      {
        url: session.callbackUrl,
        secret: session.callbackSecretEnc,
        filter: (session.callbackFilter as string[]) ?? [],
      },
      session.id,
      serialized,
    ).catch((err: unknown) => log.warn("webhook delivery failed", { sessionId: session.id, eventId: serialized.id, err: String(err) }));
  }

  return c.json({ event: serialized }, 201);
});

events.get("/", async (c) => {
  const session = c.get("session");
  const sinceRaw = c.req.query("since");
  const waitRaw = c.req.query("wait");

  let sinceId: number | null = null;
  if (sinceRaw !== undefined) {
    const n = Number(sinceRaw);
    if (!Number.isInteger(n) || n < 0) {
      throw errors.invalidRequest("?since must be a non-negative integer string");
    }
    sinceId = n;
  }
  let waitSec = 0;
  if (waitRaw !== undefined) {
    const n = Number(waitRaw);
    if (!Number.isFinite(n)) throw errors.invalidRequest("?wait must be a number");
    waitSec = Math.min(30, Math.max(0, Math.floor(n)));
  }

  async function query(): Promise<{ events: ReturnType<typeof serializeEvent>[]; next_cursor: string | null }> {
    const rows = await prisma.event.findMany({
      where: {
        sessionId: session.id,
        ...(sinceId !== null ? { id: { gt: sinceId } } : {}),
      },
      orderBy: { id: "asc" },
      take: 500,
    });
    if (rows.length === 0) {
      return { events: [], next_cursor: sinceRaw ?? null };
    }
    return {
      events: rows.map(serializeEvent),
      next_cursor: String(rows[rows.length - 1]!.id),
    };
  }

  const first = await query();
  if (first.events.length > 0 || waitSec === 0) {
    return c.json(first);
  }
  await waitForEvent(session.id, waitSec * 1000);
  return c.json(await query());
});

export default events;
