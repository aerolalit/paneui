import { Hono } from "hono";
import { z } from "zod";
import prisma from "../../db.js";
import { dualAuth, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import { waitForEvent } from "../broadcast.js";
import { serializeEvent } from "../serialize.js";
import { writeEvent } from "../../core/events.js";

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

  const body = await c.req.json().catch(() => null);
  const parsed = postBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }
  const { type, data, causation_id, idempotency_key } = parsed.data;

  const { event, deduped } = await writeEvent(session, author, {
    type,
    data,
    causationId: causation_id ?? null,
    idempotencyKey: idempotency_key ?? null,
  });

  if (deduped) {
    return c.json({ event, deduped: true }, 200);
  }
  return c.json({ event }, 201);
});

events.get("/", async (c) => {
  const session = c.get("session");
  const sinceRaw = c.req.query("since");
  const waitRaw = c.req.query("wait");

  let sinceId: number | null = null;
  if (sinceRaw !== undefined) {
    const n = Number(sinceRaw);
    if (!Number.isInteger(n) || n < 0) {
      throw errors.invalidRequest(
        "?since must be a non-negative integer string",
      );
    }
    sinceId = n;
  }
  let waitSec = 0;
  if (waitRaw !== undefined) {
    const n = Number(waitRaw);
    if (!Number.isFinite(n))
      throw errors.invalidRequest("?wait must be a number");
    waitSec = Math.min(30, Math.max(0, Math.floor(n)));
  }

  async function query(): Promise<{
    events: ReturnType<typeof serializeEvent>[];
    next_cursor: string | null;
  }> {
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
