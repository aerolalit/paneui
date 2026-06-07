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
import { Prisma } from "@prisma/client";
import type { Human as HumanRow, PrismaClient } from "@prisma/client";
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
    .catch((err: unknown) => {
      // Best-effort fire-and-forget bookkeeping. The login row can be
      // concurrently deleted (logout, account/human hard-delete, or a
      // test tearing down its fixtures) between the findUnique above and
      // this async update landing — Prisma then raises P2025 "record not
      // found". That is a legitimate no-op, not a failure: there is no
      // lastSeenAt to stamp on a row that no longer exists. Swallow it at
      // debug; surface anything else as a warning.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        log.debug("Login.lastSeenAt update skipped: login no longer exists", {
          loginId: login.id,
        });
        return;
      }
      log.warn("Login.lastSeenAt update failed", {
        loginId: login.id,
        error: String(err),
      });
    });

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

// ---------------------------------------------------------------------------
// Identity-bound participant enforcement (F-02).
//
// `POST /v1/panes/:id/identity-link` mints a Participant with a non-null
// `humanId` — a URL that ONLY that bound human may use, and only after
// logging in. The binding used to be checked in exactly one place (the
// shell HTML page), so every other consumer of the same `tok_h_…` token
// (content/presence, events, records, attachments, ws-ticket, WS upgrade)
// honoured only `revokedAt` and ignored the binding — letting anyone who
// held the raw token act AS the bound human. These helpers centralise the
// check so it is enforced wherever a participant token is resolved.
// ---------------------------------------------------------------------------

/**
 * Resolve a raw `Cookie:` header to the logged-in human id, or null if no
 * valid `pane_login` cookie is present / the login is unknown or expired.
 *
 * Read-only — unlike resolveLoginCookie it does NOT bump Login.lastSeenAt
 * (this is called from token-resolution paths that already authenticate via
 * the participant token; the cookie here is a *secondary* identity check, not
 * the primary credential, so we don't treat it as a "session was used" signal).
 * Usable from outside the Hono request lifecycle (the WS upgrade) since it
 * takes the raw header string rather than a Context.
 */
export async function loginHumanIdFromCookie(
  prisma: PrismaClient,
  cookieHeader: string | null,
): Promise<string | null> {
  const cookieValue = parseLoginCookie(cookieHeader);
  if (!cookieValue) return null;
  const login = await prisma.login.findUnique({
    where: { cookieHash: hashLoginCookie(cookieValue) },
    select: { humanId: true, expiresAt: true },
  });
  if (!login || login.expiresAt < new Date()) return null;
  return login.humanId;
}

/**
 * Central guard for an identity-bound participant token. For a participant
 * whose `humanId` is null (anonymous capability link) this is a no-op — those
 * tokens are intentionally usable by anyone with the URL. For a participant
 * whose `humanId` is set, the request MUST carry a valid login cookie for that
 * exact human; otherwise the binding fails.
 *
 * Returns `true` when the request is allowed to use the token, `false` when
 * the binding is violated (no cookie, expired cookie, or a cookie for a
 * different human). Callers translate `false` into whatever opaque rejection
 * their route family already uses (notFound for /s/* + WS, participant-token-
 * invalid for the attachment bridges) so a probing client can't tell "wrong
 * account" from "bad token".
 */
export async function participantBindingSatisfied(
  prisma: PrismaClient,
  participant: { humanId: string | null },
  cookieHeader: string | null,
): Promise<boolean> {
  if (participant.humanId === null) return true;
  const loggedInHumanId = await loginHumanIdFromCookie(prisma, cookieHeader);
  return loggedInHumanId !== null && loggedInHumanId === participant.humanId;
}
