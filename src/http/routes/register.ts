import { Hono } from "hono";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import config from "../../config.js";
import prisma from "../../db.js";
import { generateApiKey, hashKey, keyPrefix } from "../../keys.js";
import { errors } from "../errors.js";

const bodySchema = z.object({
  name: z.string().min(1).max(64).optional(),
  registration_secret: z.string(),
});

const register = new Hono();

register.post("/", async (c) => {
  if (!config.REGISTRATION_SECRET) throw errors.notFound();
  const body = await c.req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw errors.invalidRequest("invalid body", parsed.error.flatten());

  const expected = Buffer.from(config.REGISTRATION_SECRET);
  const provided = Buffer.from(parsed.data.registration_secret);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw errors.unauthorized();
  }

  const key = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      name: parsed.data.name ?? "registered",
      keyHash: hashKey(key),
      keyPrefix: keyPrefix(key),
    },
  });

  return c.json(
    {
      agent_id: agent.id,
      api_key: key,
      key_prefix: agent.keyPrefix,
    },
    201,
  );
});

export default register;
