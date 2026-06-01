// Soft-delete filter helpers (#305). Routes that read user content default to
// hiding soft-deleted rows (deletedAt != null). Callers that genuinely want to
// see trash — the /trash page (#306), CLI `pane trash list`, owner-shell
// recovery flows — opt in with `?include_deleted=true`.
//
// We expose two helpers so the call-site read is obvious:
//
//   const includeDeleted = parseIncludeDeleted(c);
//   await prisma.pane.findMany({ where: { ...softDeleteWhere(includeDeleted), agentId } })
//
// Equivalent to a hand-written `deletedAt: null`, but reading the helper makes
// the intent explicit ("we hide soft-deleted rows here"). When the call site
// honours `?include_deleted=true`, swapping `{deletedAt:null}` for `{}` is the
// only change needed.
//
// The Hono context type is generic here so this module stays import-light — it
// only reads `c.req.query("include_deleted")`. Pulling the full Hono typing
// would tie this tiny utility to the entire request-context graph for no
// benefit.

import type { Context } from "hono";

/**
 * Reads `?include_deleted=true` from the request URL. Any other value (or
 * absent) is `false`. Caller is responsible for permission-checking — only
 * the owning agent / owning human is allowed to see soft-deleted rows. This
 * helper is the parser; the gate is the route.
 */
export function parseIncludeDeleted(c: Context): boolean {
  const raw = c.req.query("include_deleted");
  return raw === "true" || raw === "1";
}

/**
 * Returns the soft-delete predicate to spread into a Prisma `where` clause.
 * `includeDeleted=true` → no predicate (`{}`), so soft-deleted rows are
 * visible. `false` → `{ deletedAt: null }`, hiding them.
 *
 * The return type uses `Record<string, unknown>` rather than per-model
 * `Prisma.XxxWhereInput` because the same predicate spreads into every
 * model that carries a `deletedAt` column (Pane, Template, Agent, Human).
 * Spreading it into a `where` of any of these types is type-safe because
 * Prisma's WhereInput is structurally compatible with the
 * `{ deletedAt: null }` literal — there's no overload risk at the call
 * site.
 */
export function softDeleteWhere(
  includeDeleted: boolean,
): Record<string, unknown> {
  return includeDeleted ? {} : { deletedAt: null };
}
