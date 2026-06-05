// Template publish + install — Phase F (§8 template distribution).
//
//   Agent-authenticated:
//     POST   /v1/templates/:id/publish      enter the public catalog
//     POST   /v1/templates/:id/unpublish    leave the public catalog
//
//   Human-authenticated:
//     GET    /v1/templates/public           browse the public catalog
//     POST   /v1/templates/:id/install      pin to installedVersion in the
//                                           caller's HumanTemplateInstall row
//     POST   /v1/templates/:id/uninstall    soft-delete (set uninstalledAt)
//
// The scopes a template declares at publish-time are stored on Template.scopes
// (Phase A schema column). Enforcement against runtime API calls is deferred
// until templates have a runtime API to call (§4.5).
//
// Publish gate (usage-maturity): the FIRST publish of a template (publishedAt
// currently null) is refused unless the template has at least
// TEMPLATE_PUBLISH_MIN_OPEN_PANES currently-open panes — status=open,
// deletedAt=null, expiresAt>now, summed across all of the template's versions.
// A re-publish of an already-published template (publishedAt set — e.g. to
// update its scopes) SKIPS the gate, as does the human-shell publish path.
// TEMPLATE_PUBLISH_MIN_OPEN_PANES=0 disables the gate entirely.

import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAgent, type AuthEnv } from "../auth.js";
import { agentScope } from "../agent-scope.js";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import { errors } from "../errors.js";
import { log } from "../../log.js";
import { comparePaneSchemas } from "../../core/schema-compat.js";
import { hasRequiredInputSchema } from "../../core/validation.js";
import {
  deleteTemplateRecord,
  listTemplateRecords,
  updateTemplateRecord,
  writeTemplateRecord,
  type TemplateWithSchema,
} from "../../core/template-records.js";
import type { EventSchema } from "../../types.js";
import {
  generatePaneId,
  generateAgentParticipantToken,
  generateHumanParticipantToken,
  hashKey,
  keyPrefix,
} from "../../keys.js";
import type { Config } from "../../config.js";
import { recordSessionCreated } from "../../telemetry/metrics.js";
import type { PrismaClient } from "@prisma/client";

// Columns the public-catalog search projects. Shared by the agent `catalog`
// and human `public` paths so the two stay in lock step.
const CATALOG_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  tags: true,
  shape: true,
  publishedAt: true,
  installCount: true,
  latestVersion: true,
  scopes: true,
} as const;

type CatalogRow = Prisma.TemplateGetPayload<{ select: typeof CATALOG_SELECT }>;

interface CatalogPage {
  items: CatalogRow[];
  total: number;
}

// Public-catalog search — DB-side + bounded (F-11).
//
// Before: when `q` was present the route DROPPED take/skip and loaded EVERY
// published template into memory, then `.filter()`/`.slice()` in JS — an
// unbounded materialisation that grows with the catalog.
//
// Now: name + description are matched in SQL via `contains` and the result is
// paginated with take/skip, so the unfiltered set is never fully loaded.
//
// Case-sensitivity tradeoff: Prisma's `mode: "insensitive"` is Postgres-only
// and is not even present on the SQLite-generated StringFilter, so it can't be
// used in code that type-checks against the SQLite client (the relay ships
// both schemas). Plain `contains` therefore compiles on both engines, and its
// runtime case-behaviour follows the engine: SQLite `LIKE` is case-INsensitive
// for ASCII (so the historical "case-insensitive" feel is preserved on the
// default self-host build), while Postgres `LIKE` is case-sensitive. This
// matches how the rest of the codebase already treats portable search.
//
// Tags: the `tags` JSON array can't be substring-matched portably (SQLite's
// Prisma `string_contains` on a JSON column is a silent no-op; `array_contains`
// is exact-element + Postgres-leaning). To preserve the historical tag-search
// behaviour without re-introducing the unbounded load, the tag pass scans a
// hard-capped (`TEMPLATE_SEARCH_SCAN_CAP`) `{id, tags}` projection, JS-filters
// for the substring, and folds the matching ids back into the SQL `where` as
// `{ id: { in } }`. The final fetch + count are a single paginated DB query.
async function searchPublicCatalog(
  prisma: PrismaClient,
  config: Config,
  q: string,
  limit: number,
  offset: number,
): Promise<CatalogPage> {
  const baseWhere: Prisma.TemplateWhereInput = { publishedAt: { not: null } };
  const orderBy: Prisma.TemplateOrderByWithRelationInput[] = [
    { installCount: "desc" },
    { publishedAt: "desc" },
  ];

  if (q.length === 0) {
    const [items, total] = await Promise.all([
      prisma.template.findMany({
        where: baseWhere,
        orderBy,
        take: limit,
        skip: offset,
        select: CATALOG_SELECT,
      }),
      prisma.template.count({ where: baseWhere }),
    ]);
    return { items, total };
  }

  // Tag-match pre-scan: bounded `{id, tags}` projection, JS substring filter.
  // SQLite `LIKE` (the `contains` translation) is case-insensitive for ASCII,
  // so to keep the tag pass consistent with the name/description pass on the
  // default build we lowercase-compare here too.
  const ql = q.toLowerCase();
  let tagMatchIds: string[] = [];
  if (config.TEMPLATE_SEARCH_SCAN_CAP > 0) {
    const tagCandidates = await prisma.template.findMany({
      where: baseWhere,
      orderBy,
      take: config.TEMPLATE_SEARCH_SCAN_CAP,
      select: { id: true, tags: true },
    });
    tagMatchIds = tagCandidates
      .filter((t) =>
        ((t.tags as string[] | null) ?? []).some((tag) =>
          tag.toLowerCase().includes(ql),
        ),
      )
      .map((t) => t.id);
  }

  const where: Prisma.TemplateWhereInput = {
    ...baseWhere,
    OR: [
      { name: { contains: q } },
      { description: { contains: q } },
      ...(tagMatchIds.length > 0 ? [{ id: { in: tagMatchIds } }] : []),
    ],
  };

  const [items, total] = await Promise.all([
    prisma.template.findMany({
      where,
      orderBy,
      take: limit,
      skip: offset,
      select: CATALOG_SELECT,
    }),
    prisma.template.count({ where }),
  ]);
  return { items, total };
}

// ----------------------------------------------------------------------
// Agent-authenticated publish/unpublish
// ----------------------------------------------------------------------
export const templatePublish = new Hono<AuthEnv>();

// Validate scope names. The vocabulary §4.5 is a living list; we accept any
// `verb:noun` form here and let Phase G/H tighten if needed.
const SCOPE_RX = /^(read|write|delete):[a-z][a-z0-9_]*$/;

const publishBody = z.object({
  // JSON array of scope strings, declared at publish-time. Frozen per
  // version: a new version reopens scope consent for installed humans.
  scopes: z.array(z.string().regex(SCOPE_RX)).max(64).optional(),
});

templatePublish.post("/:id/publish", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const me = c.get("agent");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing template id");

  let body: z.infer<typeof publishBody>;
  try {
    body = publishBody.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    throw errors.invalidRequest("invalid body", err);
  }

  const template = await prisma.template.findUnique({ where: { id } });
  // #283 — accept any same-human agent. Same not-found shape whether the
  // template is missing or owned by a stranger's agent.
  const scope = await agentScope(prisma, me);
  if (!template || !scope.has(template.ownerId)) {
    throw errors.notFound();
  }

  // Usage-maturity publish gate. Only the FIRST publish is gated: an already-
  // published template (publishedAt set) re-publishing — typically to update
  // scopes — stays allowed so the idempotent publish path never regresses.
  // "Currently-open" = status=open, deletedAt=null, expiresAt>now, counted
  // across every version of this template.
  if (
    template.publishedAt === null &&
    config.TEMPLATE_PUBLISH_MIN_OPEN_PANES > 0
  ) {
    const openPanes = await prisma.pane.count({
      where: {
        status: "open",
        deletedAt: null,
        expiresAt: { gt: new Date() },
        templateVersion: { templateId: id },
      },
    });
    if (openPanes < config.TEMPLATE_PUBLISH_MIN_OPEN_PANES) {
      throw errors.conflict(
        `template needs at least ${config.TEMPLATE_PUBLISH_MIN_OPEN_PANES} open panes to publish (currently ${openPanes})`,
        false,
        "open more panes from this template (each its own live instance) until it reaches the threshold, then publish; closed, expired, and soft-deleted panes do not count",
      );
    }
  }

  const updated = await prisma.template.update({
    where: { id },
    data: {
      publishedAt: template.publishedAt ?? new Date(),
      scopes: body.scopes ?? template.scopes ?? [],
    },
  });

  return c.json({
    id: updated.id,
    slug: updated.slug,
    name: updated.name,
    published_at: updated.publishedAt?.toISOString() ?? null,
    scopes: (updated.scopes as string[] | null) ?? [],
    install_count: updated.installCount,
  });
});

templatePublish.post("/:id/unpublish", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const me = c.get("agent");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing template id");

  const template = await prisma.template.findUnique({ where: { id } });
  const scope = await agentScope(prisma, me);
  if (!template || !scope.has(template.ownerId)) throw errors.notFound();

  await prisma.template.update({
    where: { id },
    data: { publishedAt: null },
  });

  return c.json({ id, published_at: null });
});

// GET /v1/templates/catalog — agent-side public catalog search (#279 PR C).
// Same shape as GET /v1/templates/public but agent-authed and without the
// per-human "installed" enrichment. Lets `pane template search-public`
// recommend existing apps to an agent before it creates a duplicate.
templatePublish.get("/catalog", requireAgent, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config") as Config;
  const limit = Math.min(50, Number(c.req.query("limit") ?? 25));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const q = c.req.query("q")?.trim() ?? "";

  const { items: matched, total } = await searchPublicCatalog(
    prisma,
    config,
    q,
    limit,
    offset,
  );

  return c.json({
    items: matched.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      tags: t.tags,
      shape: t.shape,
      scopes: (t.scopes as string[] | null) ?? [],
      published_at: t.publishedAt?.toISOString() ?? null,
      install_count: t.installCount,
      latest_version: t.latestVersion,
    })),
    total,
    offset,
    limit,
  });
});

// ----------------------------------------------------------------------
// Human-authenticated browse/install/uninstall
// ----------------------------------------------------------------------
export const templateMarketplace = new Hono<HumanAuthEnv>();

// GET /v1/templates/public — browse the published catalog. Lightweight:
// no HTML, no versions, just headline metadata so the picker UI can rank
// without paying the version-fetch cost.
templateMarketplace.get("/public", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config") as Config;
  const human = c.get("human");
  // Pagination: simple offset for v1 (issue tracker has a cursor follow-up).
  const limit = Math.min(50, Number(c.req.query("limit") ?? 25));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const q = c.req.query("q")?.trim() ?? "";

  // F-11 — DB-side + paginated search. See searchPublicCatalog for the
  // name/description (SQL `contains`) + tags (bounded scan) split and the
  // case-sensitivity tradeoff. Identical to the agent `/catalog` path.
  const { items: matched, total } = await searchPublicCatalog(
    prisma,
    config,
    q,
    limit,
    offset,
  );

  // Mark which the caller has already installed so the UI can render a
  // "Installed" pill without a second round-trip.
  const installs = await prisma.humanTemplateInstall.findMany({
    where: {
      humanId: human.id,
      templateId: { in: matched.map((t) => t.id) },
      uninstalledAt: null,
    },
    select: { templateId: true, installedVersion: true },
  });
  const installed = new Map(installs.map((i) => [i.templateId, i]));

  return c.json({
    items: matched.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      tags: t.tags,
      shape: t.shape,
      scopes: (t.scopes as string[] | null) ?? [],
      published_at: t.publishedAt?.toISOString() ?? null,
      install_count: t.installCount,
      latest_version: t.latestVersion,
      installed: installed.has(t.id),
      installed_version: installed.get(t.id)?.installedVersion ?? null,
    })),
    total,
    offset,
    limit,
  });
});

// POST /v1/templates/:id/install
// Body: {}  (the caller has reviewed Template.scopes via /public)
// Response: 201 { template_id, installed_version, installed_at }
//
// Pins the install to the template's current latestVersion. A later
// publish that bumps latestVersion does NOT silently upgrade — humans
// see a "new version available" prompt and must re-install (re-consent
// to any new scopes).
// #267 PR C — installs can now carry an upgrade_policy. "pin" (default)
// keeps the existing behaviour: the install sits on installedVersion until
// the human explicitly upgrades. "follow" means: when the author publishes
// a new version that's a superset of the install's current schema, the
// relay auto-advances the install. If the new version narrows the schema,
// the advance is BLOCKED (upgrade_blocked_at + upgrade_blocked_reason on
// the install row); the human resolves via the upgrade route or waits
// for a compatible version.
const installBody = z.object({
  upgrade_policy: z.enum(["pin", "follow"]).optional(),
});

templateMarketplace.post("/:id/install", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing template id");

  // Empty body OK; body with the wrong shape rejects.
  let body: z.infer<typeof installBody>;
  try {
    body = installBody.parse(await c.req.json().catch(() => ({})));
  } catch (e) {
    throw errors.invalidRequest(
      "invalid body",
      e,
      'the body must be `{ "upgrade_policy"?: "pin" | "follow" }`',
    );
  }
  const upgradePolicy = body.upgrade_policy ?? "pin";

  const template = await prisma.template.findUnique({ where: { id } });
  if (!template || !template.publishedAt) {
    // Unknown OR unpublished — same shape either way.
    throw errors.notFound();
  }

  const now = new Date();
  // Three install states:
  //   (a) no row              → first-time install: create + bump counter
  //   (b) row, uninstalledAt  → re-install of a previously-uninstalled row:
  //                             reactivate; DO NOT bump counter (the prior
  //                             uninstall already decremented it back to
  //                             where it was before)
  //   (c) row, no uninstalledAt → already installed: refresh version + no-op
  //                               on the counter
  //
  // Picking the branch requires actually knowing whether the row existed
  // pre-call. `upsert` flattens (a) into (b/c), so previously we tried to
  // infer "did create fire?" from `installedAt === now`, but `update` also
  // sets `installedAt: now`, so the predicate was always true — anyone could
  // pump the counter by calling install in a loop. Pre-check the row
  // explicitly and branch.
  const existing = await prisma.humanTemplateInstall.findUnique({
    where: { humanId_templateId: { humanId: human.id, templateId: id } },
  });

  let install;
  if (!existing) {
    // (a) First-time install. Use create+catch-P2002 so a concurrent first-
    // install on the same (humanId, templateId) — pre-checked as missing by
    // both racers — resolves to "the other one won, treat as re-install"
    // instead of throwing a 500.
    try {
      install = await prisma.humanTemplateInstall.create({
        data: {
          humanId: human.id,
          templateId: id,
          installedVersion: template.latestVersion,
          installedAt: now,
          upgradePolicy,
        },
      });
      await prisma.template.update({
        where: { id },
        data: { installCount: { increment: 1 } },
      });
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== "P2002") throw e;
      // Concurrent first-install lost the race — treat as re-install path
      // below. No counter bump (the winner already bumped).
      install = await prisma.humanTemplateInstall.update({
        where: { humanId_templateId: { humanId: human.id, templateId: id } },
        data: {
          installedVersion: template.latestVersion,
          installedAt: now,
          uninstalledAt: null,
          upgradePolicy,
          // Re-install clears any prior blocked state — the new policy +
          // version are the human's fresh intent.
          upgradeBlockedAt: null,
          upgradeBlockedReason: Prisma.JsonNull,
        },
      });
    }
  } else {
    // (b) or (c) — update existing row. No counter bump in either case;
    // an uninstall → install round-trip is net-zero, and a refresh of an
    // already-active install is a no-op against the counter.
    install = await prisma.humanTemplateInstall.update({
      where: { humanId_templateId: { humanId: human.id, templateId: id } },
      data: {
        installedVersion: template.latestVersion,
        installedAt: now,
        uninstalledAt: null,
        upgradePolicy,
        upgradeBlockedAt: null,
        upgradeBlockedReason: Prisma.JsonNull,
      },
    });
  }

  return c.json(
    {
      template_id: id,
      installed_version: install.installedVersion,
      installed_at: install.installedAt.toISOString(),
      upgrade_policy: install.upgradePolicy,
    },
    201,
  );
});

// POST /v1/templates/:id/upgrade — re-pin an install to another version of
// the same template (#267 PR C). Mirrors the pane-side upgrade route but
// operates on HumanTemplateInstall.installedVersion. Same compat gate;
// same compat="strict" | "force" semantics.
const upgradeInstallBody = z.object({
  to_version: z.number().int().positive().optional(),
  compat: z.enum(["strict", "force"]).optional(),
});
templateMarketplace.post("/:id/upgrade", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing template id");

  let body: z.infer<typeof upgradeInstallBody>;
  try {
    body = upgradeInstallBody.parse(await c.req.json().catch(() => ({})));
  } catch (e) {
    throw errors.invalidRequest(
      "invalid body",
      e,
      'the body must be `{ "to_version"?: number, "compat"?: "strict" | "force" }`',
    );
  }
  const compat = body.compat ?? "strict";

  const install = await prisma.humanTemplateInstall.findUnique({
    where: { humanId_templateId: { humanId: human.id, templateId: id } },
    include: { template: true },
  });
  if (!install || install.uninstalledAt) {
    // Not installed (or uninstalled) — caller should install first; same
    // not-found shape as if the template id were unknown.
    throw errors.notFound();
  }

  // Source version = whatever the install currently sits on. Target version
  // defaults to the template's latest published version.
  const targetVersionNum = body.to_version ?? install.template.latestVersion;
  if (targetVersionNum === install.installedVersion) {
    // No-op: already on the requested version. Clear any prior blocked
    // state since the install matches its target.
    if (install.upgradeBlockedAt) {
      await prisma.humanTemplateInstall.update({
        where: { id: install.id },
        data: {
          upgradeBlockedAt: null,
          upgradeBlockedReason: Prisma.JsonNull,
        },
      });
    }
    return c.json({
      template_id: id,
      installed_version: install.installedVersion,
      upgraded: false,
      breaks: [],
      compat,
    });
  }

  // Look up both versions for the schema diff.
  const [fromVersion, toVersion] = await Promise.all([
    prisma.templateVersion.findUnique({
      where: {
        templateId_version: {
          templateId: id,
          version: install.installedVersion,
        },
      },
    }),
    prisma.templateVersion.findUnique({
      where: {
        templateId_version: { templateId: id, version: targetVersionNum },
      },
    }),
  ]);
  if (!toVersion) throw errors.artifactVersionNotFound();
  if (!fromVersion) {
    // The installed_version no longer exists in the version history —
    // shouldn't happen (versions are immutable + append-only) but if it
    // does, fall through to a force-style apply: we can't compute breaks
    // without the old schema.
    throw errors.notFound();
  }

  const breaks = comparePaneSchemas({
    oldEventSchema: fromVersion.eventSchema as unknown as EventSchema | null,
    newEventSchema: toVersion.eventSchema as unknown as EventSchema | null,
    oldInputSchema: fromVersion.inputSchema as Record<string, unknown> | null,
    newInputSchema: toVersion.inputSchema as Record<string, unknown> | null,
  });
  if (breaks.length > 0 && compat === "strict") {
    throw errors.schemaIncompatibleUpgrade(breaks);
  }

  await prisma.humanTemplateInstall.update({
    where: { id: install.id },
    data: {
      installedVersion: targetVersionNum,
      // Successful upgrade always clears blocked state.
      upgradeBlockedAt: null,
      upgradeBlockedReason: Prisma.JsonNull,
    },
  });

  return c.json({
    template_id: id,
    installed_version: targetVersionNum,
    upgraded: true,
    breaks,
    compat,
  });
});

// POST /v1/templates/:id/uninstall
// Sets uninstalledAt; doesn't delete the row, so re-install preserves
// the prior install's history. Decrement install_count.
templateMarketplace.post("/:id/uninstall", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing template id");

  const install = await prisma.humanTemplateInstall.findUnique({
    where: { humanId_templateId: { humanId: human.id, templateId: id } },
  });
  if (!install || install.uninstalledAt) {
    // Not installed — idempotent no-op.
    return c.body(null, 204);
  }

  await prisma.humanTemplateInstall.update({
    where: { id: install.id },
    data: { uninstalledAt: new Date() },
  });

  // Decrement the catalog counter (floor at 0 for safety).
  await prisma.template.updateMany({
    where: { id, installCount: { gt: 0 } },
    data: { installCount: { decrement: 1 } },
  });

  return c.body(null, 204);
});

// ----------------------------------------------------------------------
// Human-as-template-owner: publish/unpublish via the /my-templates UI.
//
// Mounted at /v1/my-templates so it can't collide with the agent-authed
// /v1/templates/:id/{publish,unpublish}. Authorization: the caller must
// be the human who owns the agent that owns the template.
// ----------------------------------------------------------------------
export const myTemplates = new Hono<HumanAuthEnv>();

const ownerPublishBody = z.object({
  scopes: z.array(z.string().regex(SCOPE_RX)).max(64).optional(),
});

myTemplates.post("/:id/publish", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing template id");

  let body: z.infer<typeof ownerPublishBody>;
  try {
    body = ownerPublishBody.parse(await c.req.json().catch(() => ({})));
  } catch (err) {
    throw errors.invalidRequest("invalid body", err);
  }

  const template = await prisma.template.findUnique({
    where: { id },
    include: { owner: { select: { ownerHumanId: true } } },
  });
  // Same not-found shape whether the template is missing or owned by
  // someone else's agent — no enumeration oracle.
  if (!template || template.owner.ownerHumanId !== human.id) {
    throw errors.notFound();
  }

  const updated = await prisma.template.update({
    where: { id },
    data: {
      publishedAt: template.publishedAt ?? new Date(),
      scopes: body.scopes ?? template.scopes ?? [],
    },
  });

  return c.json({
    id: updated.id,
    slug: updated.slug,
    name: updated.name,
    published_at: updated.publishedAt?.toISOString() ?? null,
    scopes: (updated.scopes as string[] | null) ?? [],
    install_count: updated.installCount,
  });
});

myTemplates.post("/:id/unpublish", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing template id");

  const template = await prisma.template.findUnique({
    where: { id },
    include: { owner: { select: { ownerHumanId: true } } },
  });
  if (!template || template.owner.ownerHumanId !== human.id) {
    throw errors.notFound();
  }

  await prisma.template.update({
    where: { id },
    data: { publishedAt: null },
  });

  return c.json({ id, published_at: null });
});

// DELETE /v1/my-templates/:id — soft-delete a template the human owns.
//
// Mirrors DELETE /v1/my-panes/:id (cookie-authed soft-delete) but for the
// template head. Versions stay on disk; panes pinned to those versions
// keep working until they expire. Sweeper #304 hard-deletes the row past
// retention. Strict-cascade refusal lives on the agent-authed
// /v1/templates/:id — for the human-shell path we prefer "remove from my
// list" semantics over a 409, which would be confusing in a tile menu.
//
// 404 if the template doesn't exist or isn't owned by one of the human's
// claimed agents. Idempotent: a second DELETE on an already-trashed
// template returns 204.
myTemplates.delete("/:id", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing template id");

  const template = await prisma.template.findUnique({
    where: { id },
    include: { owner: { select: { id: true, ownerHumanId: true } } },
  });
  if (!template || template.owner.ownerHumanId !== human.id) {
    throw errors.notFound();
  }
  if (template.deletedAt !== null) {
    return c.body(null, 204);
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.template.update({
      where: { id },
      data: { deletedAt: now },
    }),
    prisma.deletionLog.create({
      data: {
        entityType: "template",
        entityId: id,
        ownerHumanId: human.id,
        ownerAgentId: template.owner.id,
        phase: "soft_deleted",
        reason: "human_delete",
        at: now,
      },
    }),
  ]);

  log.info("my-templates: soft-deleted", { templateId: id, humanId: human.id });
  return c.body(null, 204);
});

// POST /v1/my-templates/:id/launch — create a pane from an installed template.
//
// Closes the dead-end-UX gap where Install added the template to the human's
// library but offered no way for the human to actually use it. The new pane:
//   - Pins to the install's installedVersion (consistent with how an agent-
//     created pane references a templateVersion).
//   - Sets ownerHumanId = calling human, so the pane appears in /my-panes.
//   - Sets agentId = template.ownerId, which is owned by the calling human
//     (cross-agent-same-human, #283), so existing per-agent indices stay
//     consistent without minting a brand-new agent.
//   - Mints one human participant token and returns its URL — the UI navigates
//     there immediately.
//
// Mirrors the reference-form panes.ts create (lines 660-720) but trimmed to
// the essentials: no dedup, no input_data, no callbacks. Anything beyond
// "open a pane" is the agent-driven path and stays on POST /v1/panes.
const LAUNCH_TTL_MS = 24 * 60 * 60 * 1000; // 24h — same default as panes.ts.
myTemplates.post("/:id/launch", requireHuman, async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config") as Config;
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing template id");

  // Two paths to launch:
  //   (a) The human installed this template from the public catalog. The
  //       install row pins the version they accepted scopes for.
  //   (b) The human owns the template directly (it's authored by one of
  //       their claimed agents). They don't need to install their own
  //       work — they can launch the latest version.
  //
  // Either path resolves to a (template, versionNumber) pair we use below.
  // 404 for any failure mode (not-found, soft-deleted, not-yours) — same
  // no-enumeration shape as publish/unpublish.
  const [install, ownedTemplate] = await Promise.all([
    prisma.humanTemplateInstall.findUnique({
      where: { humanId_templateId: { humanId: human.id, templateId: id } },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            slug: true,
            ownerId: true,
            deletedAt: true,
            owner: { select: { ownerHumanId: true } },
          },
        },
      },
    }),
    prisma.template.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        ownerId: true,
        latestVersion: true,
        deletedAt: true,
        owner: { select: { ownerHumanId: true } },
      },
    }),
  ]);

  let templateForPane: {
    id: string;
    name: string | null;
    slug: string | null;
    ownerId: string;
  } | null = null;
  let versionNumber = 0;

  if (
    install &&
    install.uninstalledAt === null &&
    install.template.deletedAt === null
  ) {
    templateForPane = {
      id: install.template.id,
      name: install.template.name,
      slug: install.template.slug,
      ownerId: install.template.ownerId,
    };
    versionNumber = install.installedVersion;
  } else if (
    ownedTemplate &&
    ownedTemplate.deletedAt === null &&
    ownedTemplate.owner.ownerHumanId === human.id
  ) {
    templateForPane = {
      id: ownedTemplate.id,
      name: ownedTemplate.name,
      slug: ownedTemplate.slug,
      ownerId: ownedTemplate.ownerId,
    };
    versionNumber = ownedTemplate.latestVersion;
  }

  if (!templateForPane || versionNumber === 0) {
    throw errors.notFound();
  }

  const version = await prisma.templateVersion.findUnique({
    where: {
      templateId_version: {
        templateId: templateForPane.id,
        version: versionNumber,
      },
    },
  });
  if (!version) {
    throw errors.notFound();
  }

  // Agent-init guard. A template whose pinned version's input_schema declares
  // required fields can't be launched cold by a human: the launched pane would
  // carry no input_data, fail nothing (launch doesn't validate), and render
  // the template's "needs initialization" empty state — a dead end. Such a
  // pane must be created by an agent via POST /v1/panes with input_data. The
  // owner-shell tile classifies the same way (hasRequiredInputSchema → the
  // "agent-init" badge) and blocks the click, but a direct API call has to be
  // refused here too.
  if (hasRequiredInputSchema(version.inputSchema)) {
    throw errors.conflict(
      "this template requires agent-supplied input_data and cannot be launched directly",
      false,
      "the template's input_schema declares required fields; an agent must create the pane via POST /v1/panes with input_data. Launch is only for templates that render with no setup.",
    );
  }

  const paneId = generatePaneId();
  const humanToken = generateHumanParticipantToken();
  const agentToken = generateAgentParticipantToken();
  const expiresAt = new Date(Date.now() + LAUNCH_TTL_MS);
  const title =
    templateForPane.name ?? templateForPane.slug ?? templateForPane.id;

  await prisma.pane.create({
    data: {
      id: paneId,
      agentId: templateForPane.ownerId,
      ownerHumanId: human.id,
      creatorKind: "human",
      creatorId: human.id,
      templateVersionId: version.id,
      title,
      expiresAt,
      participants: {
        create: [
          {
            kind: "agent",
            identityId: templateForPane.ownerId,
            tokenHash: hashKey(agentToken),
            tokenPrefix: keyPrefix(agentToken),
          },
          {
            kind: "human",
            identityId: human.id,
            tokenHash: hashKey(humanToken),
            tokenPrefix: keyPrefix(humanToken),
          },
        ],
      },
    },
  });

  // Bump the template's last-used timestamp — search ranks by it.
  await prisma.template.update({
    where: { id: templateForPane.id },
    data: { lastUsedAt: new Date() },
  });

  recordSessionCreated();

  return c.json(
    {
      pane_id: paneId,
      urls: {
        humans: [`${config.publicUrl}/s/${humanToken}`],
      },
    },
    201,
  );
});

// ----------------------------------------------------------------------
// Cookie-authed template-records read + write — drives the
// /my-templates/:id/content management UI.
//
// Parallels the agent-authed routes in routes/template-records.ts but
// authenticates via the human's pane_login cookie. Authorization mirrors
// publish/unpublish above: the calling human must own the template's
// owner-agent. The 404 shape on miss/not-owned defeats the enumeration
// oracle.
//
// Author kind for writes is "human" — the owner directly is the author,
// not one of their agents. (An agent-side CLI write still uses the
// agent-authed surface and stamps "agent".)
// ----------------------------------------------------------------------

// Helper — looks up the template head + latest version, runs the
// owner-only authz check, and returns a TemplateWithSchema ready for the
// core writer. Centralises the auth + 404 across the four verbs.
async function loadOwnedTemplate(
  c: import("hono").Context<HumanAuthEnv>,
): Promise<TemplateWithSchema> {
  const prisma = c.get("prisma");
  const human = c.get("human");
  const id = c.req.param("id");
  if (!id) throw errors.invalidRequest("missing template id");
  const template = await prisma.template.findUnique({
    where: { id },
    include: { owner: { select: { ownerHumanId: true } } },
  });
  if (!template || template.owner.ownerHumanId !== human.id) {
    throw errors.notFound();
  }
  if (template.deletedAt !== null) throw errors.softDeleted("template");
  const latestVersionRow = await prisma.templateVersion.findUnique({
    where: {
      templateId_version: {
        templateId: template.id,
        version: template.latestVersion,
      },
    },
  });
  if (!latestVersionRow) throw errors.notFound();
  return Object.assign(template, { latestVersionRow });
}

const trecPostBody = z.object({
  record_key: z.string().min(1).max(256).optional(),
  data: z.unknown(),
});
const trecPatchBody = z.object({
  if_match: z.number().int().nonnegative().optional(),
  data: z.unknown(),
});
const trecDeleteBody = z
  .object({ if_match: z.number().int().nonnegative().optional() })
  .optional();

// GET /v1/my-templates/:id/template-records/:collection
myTemplates.get(
  "/:id/template-records/:collection",
  requireHuman,
  async (c) => {
    const prisma = c.get("prisma");
    const template = await loadOwnedTemplate(c);
    const collection = c.req.param("collection");
    if (!collection) throw errors.invalidRequest("missing collection name");
    const sinceRaw = c.req.query("since");
    let since = 0;
    if (sinceRaw !== undefined) {
      const n = Number(sinceRaw);
      if (!Number.isInteger(n) || n < 0) {
        throw errors.invalidRequest(
          "?since must be a non-negative integer string",
        );
      }
      since = n;
    }
    const limit = 200;
    const out = await listTemplateRecords(prisma, template, collection, {
      since,
      limit,
    });
    return c.json(out);
  },
);

// POST /v1/my-templates/:id/template-records/:collection
myTemplates.post(
  "/:id/template-records/:collection",
  requireHuman,
  async (c) => {
    const prisma = c.get("prisma");
    const human = c.get("human");
    const template = await loadOwnedTemplate(c);
    const collection = c.req.param("collection");
    if (!collection) throw errors.invalidRequest("missing collection name");
    const body = await c.req.json().catch(() => null);
    const parsed = trecPostBody.safeParse(body);
    if (!parsed.success) {
      throw errors.invalidRequest(
        "invalid body",
        parsed.error.flatten(),
        "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
      );
    }
    const { record, deduped } = await writeTemplateRecord(
      { prisma, config: c.get("config") as Config },
      template,
      { kind: "human", id: human.id },
      {
        collectionName: collection,
        recordKey: parsed.data.record_key,
        data: parsed.data.data,
      },
    );
    if (deduped) return c.json({ record, deduped: true }, 200);
    return c.json({ record }, 201);
  },
);

// PATCH /v1/my-templates/:id/template-records/:collection/:recordKey
myTemplates.patch(
  "/:id/template-records/:collection/:recordKey",
  requireHuman,
  async (c) => {
    const prisma = c.get("prisma");
    const human = c.get("human");
    const template = await loadOwnedTemplate(c);
    const collection = c.req.param("collection");
    const recordKey = c.req.param("recordKey");
    if (!collection || !recordKey)
      throw errors.invalidRequest("missing collection or record key");
    const body = await c.req.json().catch(() => null);
    const parsed = trecPatchBody.safeParse(body);
    if (!parsed.success) {
      throw errors.invalidRequest(
        "invalid body",
        parsed.error.flatten(),
        "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
      );
    }
    const { record } = await updateTemplateRecord(
      { prisma, config: c.get("config") as Config },
      template,
      { kind: "human", id: human.id },
      {
        collectionName: collection,
        recordKey,
        data: parsed.data.data,
        ifMatch: parsed.data.if_match,
      },
    );
    return c.json({ record });
  },
);

// DELETE /v1/my-templates/:id/template-records/:collection/:recordKey
myTemplates.delete(
  "/:id/template-records/:collection/:recordKey",
  requireHuman,
  async (c) => {
    const prisma = c.get("prisma");
    const human = c.get("human");
    const template = await loadOwnedTemplate(c);
    const collection = c.req.param("collection");
    const recordKey = c.req.param("recordKey");
    if (!collection || !recordKey)
      throw errors.invalidRequest("missing collection or record key");
    let ifMatch: number | undefined;
    if (c.req.header("content-length") !== "0") {
      const body = await c.req.json().catch(() => null);
      if (body !== null) {
        const parsed = trecDeleteBody.safeParse(body);
        if (!parsed.success) {
          throw errors.invalidRequest(
            "invalid body",
            parsed.error.flatten(),
            "DELETE body is optional; when present it must match { if_match?: number }",
          );
        }
        ifMatch = parsed.data?.if_match;
      }
    }
    await deleteTemplateRecord(
      { prisma },
      template,
      { kind: "human", id: human.id },
      { collectionName: collection, recordKey, ifMatch },
    );
    return c.body(null, 204);
  },
);
