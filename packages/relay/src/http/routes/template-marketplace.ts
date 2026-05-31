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

import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAgent, type AuthEnv } from "../auth.js";
import { agentScope } from "../agent-scope.js";
import { requireHuman, type HumanAuthEnv } from "../../auth/human-auth.js";
import { errors } from "../errors.js";
import { compareSurfaceSchemas } from "../../core/schema-compat.js";
import type { EventSchema } from "../../types.js";

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
  const limit = Math.min(50, Number(c.req.query("limit") ?? 25));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const q = c.req.query("q")?.trim() ?? "";

  const baseWhere: Prisma.TemplateWhereInput = {
    publishedAt: { not: null },
  };
  const items = await prisma.template.findMany({
    where: baseWhere,
    orderBy: [{ installCount: "desc" }, { publishedAt: "desc" }],
    ...(q.length === 0 ? { take: limit, skip: offset } : {}),
    select: {
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
    },
  });
  const ql = q.toLowerCase();
  const filtered =
    q.length > 0
      ? items.filter(
          (t) =>
            (t.name && t.name.toLowerCase().includes(ql)) ||
            (t.description && t.description.toLowerCase().includes(ql)) ||
            ((t.tags as string[] | null) ?? []).some((tag) =>
              tag.toLowerCase().includes(ql),
            ),
        )
      : items;
  const total =
    q.length === 0
      ? await prisma.template.count({ where: baseWhere })
      : filtered.length;
  const matched =
    q.length > 0 ? filtered.slice(offset, offset + limit) : filtered;

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
  const human = c.get("human");
  // Pagination: simple offset for v1 (issue tracker has a cursor follow-up).
  const limit = Math.min(50, Number(c.req.query("limit") ?? 25));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const q = c.req.query("q")?.trim() ?? "";
  // Filter post-DB: SQLite Prisma can't do case-insensitive `contains`
  // on `name`/`description` and can't match inside a JSON tag array.
  // The published catalog is bounded (few hundred rows) so load-then-
  // filter is fine until we need fts.
  const baseWhere: Prisma.TemplateWhereInput = {
    publishedAt: { not: null },
  };
  const items = await prisma.template.findMany({
    where: baseWhere,
    orderBy: [{ installCount: "desc" }, { publishedAt: "desc" }],
    ...(q.length === 0 ? { take: limit, skip: offset } : {}),
    select: {
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
    },
  });
  const ql = q.toLowerCase();
  const filtered =
    q.length > 0
      ? items.filter(
          (t) =>
            (t.name && t.name.toLowerCase().includes(ql)) ||
            (t.description && t.description.toLowerCase().includes(ql)) ||
            ((t.tags as string[] | null) ?? []).some((tag) =>
              tag.toLowerCase().includes(ql),
            ),
        )
      : items;
  const total =
    q.length === 0
      ? await prisma.template.count({ where: baseWhere })
      : filtered.length;
  const matched =
    q.length > 0 ? filtered.slice(offset, offset + limit) : filtered;

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
// the same template (#267 PR C). Mirrors the surface-side upgrade route but
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

  const breaks = compareSurfaceSchemas({
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
