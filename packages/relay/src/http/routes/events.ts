import { Hono } from "hono";
import { z } from "zod";
import { dualAuth, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import { openWaiter } from "../broadcast.js";
import { serializeEvent } from "../serialize.js";
import { writeEvent } from "../../core/events.js";
import {
  MAX_EVENT_TYPE_LENGTH,
  MAX_CAUSATION_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from "../../limits.js";

const events = new Hono<AuthEnv>();

events.use("*", dualAuth);

const postBody = z.object({
  type: z.string().min(1).max(MAX_EVENT_TYPE_LENGTH),
  data: z.unknown(),
  causation_id: z.string().min(1).max(MAX_CAUSATION_ID_LENGTH).optional(),
  idempotency_key: z.string().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH).optional(),
});

events.post("/", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const pane = c.get("pane");
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

  const { event, deduped } = await writeEvent(
    { prisma, config },
    pane,
    author,
    {
      type,
      data,
      causationId: causation_id ?? null,
      idempotencyKey: idempotency_key ?? null,
    },
  );

  if (deduped) {
    return c.json({ event, deduped: true }, 200);
  }
  return c.json({ event }, 201);
});

events.get("/", async (c) => {
  const prisma = c.get("prisma");
  const pane = c.get("pane");
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
        paneId: pane.id,
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

  if (waitSec === 0) {
    return c.json(await query());
  }

  // Subscribe to the broadcast bus BEFORE the first query so that an event
  // published during the query window is buffered rather than missed by both
  // the query and the subsequent waiter (long-poll race, issue #49).
  const waiter = openWaiter(pane.id);
  try {
    const first = await query();
    if (first.events.length > 0) {
      return c.json(first);
    }
    await waiter.wait(waitSec * 1000);
    return c.json(await query());
  } finally {
    waiter.close();
  }
});

export default events;
