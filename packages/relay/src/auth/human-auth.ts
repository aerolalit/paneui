// resolveHuman — middleware that turns a `pane_login` cookie into a
// `Human` row on the request context. Used by /v1/self/* and any other
// route the human-side UI calls.
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

import type { Context, MiddlewareHandler } from "hono";
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

export type OptionalHumanAuthEnv = AppEnv & {
  Variables: AppEnv["Variables"] & {
    /** Set when a valid login cookie was present; null otherwise. */
    human: HumanRow | null;
  };
};

// Generic context type — anything that carries the AppEnv variables
// (prisma in particular) on its `Variables`. Both HumanAuthEnv and
// OptionalHumanAuthEnv extend AppEnv, so this signature accepts both.
type ContextWithPrisma = Pick<Context<AppEnv>, "get" | "req">;

async function resolveLoginCookie(
  c: ContextWithPrisma,
): Promise<HumanRow | null> {
  const prisma = c.get("prisma");
  const cookieValue = parseLoginCookie(c.req.header("cookie") ?? null);
  if (!cookieValue) return null;
  const cookieHash = hashLoginCookie(cookieValue);

  const login = await prisma.login.findUnique({
    where: { cookieHash },
    include: { human: true },
  });
  if (!login || login.expiresAt < new Date()) return null;

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

  return login.human;
}

/** Hard cookie gate — 401 if no valid login. Use for /v1/self/* etc. */
export const requireHuman: MiddlewareHandler<HumanAuthEnv> = async (
  c,
  next,
) => {
  const config = c.get("config");
  const human = await resolveLoginCookie(c);
  if (!human) {
    c.header(
      "Set-Cookie",
      buildClearCookieHeader({ isProduction: config.isProduction }),
    );
    throw errors.unauthorized();
  }
  c.set("human", human);
  await next();
};

/** Soft cookie gate — resolves Human if a valid cookie is present, sets
 * null otherwise. Use on routes that have a logged-in UX AND a
 * logged-out UX (the bridge / system pages). */
export const resolveHumanOptional: MiddlewareHandler<
  OptionalHumanAuthEnv
> = async (c, next) => {
  const human = await resolveLoginCookie(c);
  c.set("human", human);
  await next();
};
