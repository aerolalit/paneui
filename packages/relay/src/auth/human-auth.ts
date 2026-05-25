// resolveHuman — middleware that turns a `pane_login` cookie into a
// `Human` row on the request context. Used by /v1/self/* and any other
// route the human-side UI calls through the runtime API.
//
// Failure modes:
//   - No cookie at all                     → 401 unauthorized
//   - Cookie present but unknown / expired → 401 unauthorized (cookie
//                                             cleared on the response)
//   - Cookie valid → human loaded; `c.set("human", human)` and continue
//
// The middleware also bumps `Login.lastSeenAt` (best-effort; failures
// are logged but don't block the request). This is the only place the
// timestamp moves.

import type { MiddlewareHandler } from "hono";
import type { Human as HumanRow } from "@prisma/client";
import {
  buildClearCookieHeader,
  hashLoginCookie,
  parseLoginCookie,
} from "./cookie.js";
import { log } from "../log.js";
import type { AppEnv } from "../http/env.js";
import { errors } from "../http/errors.js";

export type HumanAuthEnv = AppEnv & {
  Variables: AppEnv["Variables"] & {
    human: HumanRow;
  };
};

export const requireHuman: MiddlewareHandler<HumanAuthEnv> = async (
  c,
  next,
) => {
  const prisma = c.get("prisma");
  const config = c.get("config");

  const cookieValue = parseLoginCookie(c.req.header("cookie") ?? null);
  if (!cookieValue) throw errors.unauthorized();
  const cookieHash = hashLoginCookie(cookieValue);

  const login = await prisma.login.findUnique({
    where: { cookieHash },
    include: { human: true },
  });
  // Cookie unknown OR expired — clear it on the way out and 401.
  if (!login || login.expiresAt < new Date()) {
    c.header(
      "Set-Cookie",
      buildClearCookieHeader({ isProduction: config.isProduction }),
    );
    throw errors.unauthorized();
  }

  // Best-effort bump of lastSeenAt. Doesn't block the request — the
  // resolved Human row was already loaded.
  prisma.login
    .update({
      where: { id: login.id },
      data: { lastSeenAt: new Date() },
    })
    .catch((err: unknown) =>
      log.warn("Login.lastSeenAt update failed", {
        loginId: login.id,
        error: String(err),
      }),
    );

  c.set("human", login.human);
  await next();
};
