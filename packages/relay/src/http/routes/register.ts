// POST /v1/register — open agent self-registration.
//
// No secret, no bearer key: this is the call that *obtains* an API key.
// Abuse is bounded by a per-IP sliding-window rate limit (see rate-limit.ts).

import { Hono } from "hono";
import { z } from "zod";
import { generateApiKey, hashKey, keyPrefix } from "../../keys.js";
import type { AppEnv } from "../env.js";
import { errors } from "../errors.js";
import { enforceRegisterRateLimit } from "../rate-limit.js";
import { recordRegistration } from "../../telemetry/metrics.js";

const bodySchema = z.object({
  name: z.string().min(1).max(64).optional(),
});

const register = new Hono<AppEnv>();

register.post("/", async (c) => {
  enforceRegisterRateLimit(c);
  const prisma = c.get("prisma");

  // Body is optional — a bare `pane register` sends none. Treat missing /
  // empty / non-JSON body as {} so the only failure path is a malformed name.
  const raw = await c.req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success)
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );

  const key = generateApiKey();
  const agent = await prisma.agent.create({
    data: {
      name: parsed.data.name ?? "registered",
      keyHash: hashKey(key),
      keyPrefix: keyPrefix(key),
    },
  });

  recordRegistration();

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
