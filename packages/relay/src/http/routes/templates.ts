import { Hono } from "hono";
import { Prisma, type PrismaClient } from "@prisma/client";
import { log } from "../../log.js";
import { comparePaneSchemas } from "../../core/schema-compat.js";
import {
  createArtifactSchema,
  createArtifactVersionSchema,
  patchArtifactMetadataSchema,
  isRasterImageMime,
} from "@paneui/core";
import type { Config } from "../../config.js";
import { requireAgent, type AuthEnv } from "../auth.js";
import { agentScope } from "../agent-scope.js";
import { errors } from "../errors.js";
import { parseIncludeDeleted, softDeleteWhere } from "../../db/soft-delete.js";
import {
  assertSchemaWithinLimits,
  assertValidInputSchema,
  validateRecordSchemaShape,
  validateSchemaShape,
} from "../../core/validation.js";
import type { EventSchema } from "../../types.js";

const templates = new Hono<AuthEnv>();

templates.use("*", requireAgent);

// Shared validation for an template version's content (POST /v1/templates and
// POST /v1/templates/:id/versions). Throws an ApiError on any violation.
// Returns the normalized event schema to persist, or `null` when the version
// declares no event schema — a view-only template (report/dashboard/chart) the
// human only views. A present-but-malformed schema is still rejected.
function validateVersionContent(
  config: Config,
  content: {
    source: string;
    type: "html-inline" | "html-ref";
    event_schema: unknown;
    input_schema?: unknown;
    record_schema?: unknown;
    template_record_schema?: unknown;
  },
): EventSchema | null {
  if (Buffer.byteLength(content.source, "utf8") > config.MAX_ARTIFACT_BYTES) {
    throw errors.payloadTooLarge();
  }
  if (content.type === "html-ref") {
    // Mirrors the pane route: v1 does not serve html-ref templates (a blank
    // iframe with no error — issue #24). Reject at create time.
    throw errors.invalidRequest(
      "template type 'html-ref' is not supported in this release",
      undefined,
      "use type 'html-inline' and pass the template HTML in source",
    );
  }
  // An absent event_schema = a view-only template: no event vocabulary. Skip
  // schema-shape validation entirely and persist null. input_schema is
  // independent — a view-only template may still carry one (reusable report
  // template), so it is validated below regardless.
  let eventSchema: EventSchema | null = null;
  if (content.event_schema !== undefined) {
    assertSchemaWithinLimits(content.event_schema, {
      maxBytes: config.MAX_SCHEMA_BYTES,
      maxDepth: config.MAX_SCHEMA_DEPTH,
    });
    eventSchema = validateSchemaShape(content.event_schema);
  }
  if (content.input_schema !== undefined) {
    assertValidInputSchema(content.input_schema);
  }
  // Validate record_schema shape (JSON Schema 2020-12 + x-pane-collections)
  // before persisting. A 400 here means an agent supplied a malformed schema.
  if (content.record_schema !== undefined) {
    assertSchemaWithinLimits(content.record_schema, {
      maxBytes: config.MAX_SCHEMA_BYTES,
      maxDepth: config.MAX_SCHEMA_DEPTH,
    });
    validateRecordSchemaShape(content.record_schema);
  }
  // template_record_schema reuses the per-pane records shape validator (same
  // JSON Schema 2020-12 + x-pane-collections grammar, separate storage).
  if (content.template_record_schema !== undefined) {
    assertSchemaWithinLimits(content.template_record_schema, {
      maxBytes: config.MAX_SCHEMA_BYTES,
      maxDepth: config.MAX_SCHEMA_DEPTH,
    });
    validateRecordSchemaShape(content.template_record_schema);
  }
  return eventSchema;
}

function tagsToJson(
  tags: string[] | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return tags ? (tags as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;
}

// Lean summary shape for list/search — head metadata only, no source attachment.
function summarize(a: {
  id: string;
  slug: string | null;
  name: string | null;
  description: string | null;
  tags: Prisma.JsonValue;
  latestVersion: number;
  lastUsedAt: Date | null;
}) {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description,
    tags: a.tags ?? null,
    latest_version: a.latestVersion,
    last_used_at: a.lastUsedAt?.toISOString() ?? null,
  };
}

function serializeVersion(v: {
  id: string;
  version: number;
  templateType: string;
  templateSource: string;
  eventSchema: Prisma.JsonValue;
  inputSchema: Prisma.JsonValue;
  recordSchema?: Prisma.JsonValue;
  templateRecordSchema?: Prisma.JsonValue;
  createdAt: Date;
}) {
  return {
    id: v.id,
    version: v.version,
    type: v.templateType,
    source: v.templateSource,
    // null = view-only template (no event vocabulary).
    event_schema: v.eventSchema ?? null,
    input_schema: v.inputSchema ?? null,
    record_schema: v.recordSchema ?? null,
    template_record_schema: v.templateRecordSchema ?? null,
    created_at: v.createdAt.toISOString(),
  };
}

// POST /v1/templates — create a named template + its v1 content.
templates.post("/", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const agent = c.get("agent");

  const body = await c.req.json().catch(() => null);
  const parsed = createArtifactSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }
  const {
    name,
    slug,
    description,
    tags,
    source,
    type,
    event_schema,
    input_schema,
    record_schema,
    template_record_schema,
    icon_emoji,
  } = parsed.data;

  const eventSchema = validateVersionContent(config, {
    source,
    type,
    event_schema,
    input_schema,
    record_schema,
    template_record_schema,
  });

  // Per-agent template cap (count-then-create — a soft cap, see the pane
  // route's identical note).
  if (config.MAX_ARTIFACTS_PER_AGENT > 0) {
    const count = await prisma.template.count({
      where: { ownerId: agent.id },
    });
    if (count >= config.MAX_ARTIFACTS_PER_AGENT) {
      throw errors.tooManyRequests(
        `template cap reached (max ${config.MAX_ARTIFACTS_PER_AGENT} per agent); delete an existing template before creating a new one`,
      );
    }
  }

  let template;
  try {
    template = await prisma.$transaction(async (tx) => {
      const head = await tx.template.create({
        data: {
          ownerId: agent.id,
          name,
          slug: slug ?? null,
          description: description ?? null,
          tags: tagsToJson(tags),
          latestVersion: 1,
          // Icon emoji is validated by the Zod schema (single grapheme).
          // Image icons are set post-create via PATCH once the attachment
          // can reference this template's id.
          iconEmoji: icon_emoji ?? null,
        },
      });
      await tx.templateVersion.create({
        data: {
          templateId: head.id,
          version: 1,
          templateType: type,
          templateSource: source,
          eventSchema:
            eventSchema !== null
              ? (eventSchema as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          inputSchema:
            input_schema !== undefined
              ? (input_schema as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          recordSchema:
            record_schema !== undefined
              ? (record_schema as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          templateRecordSchema:
            template_record_schema !== undefined
              ? (template_record_schema as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        },
      });
      return head;
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw errors.conflict(
        `slug '${slug}' is already used by another of your templates`,
      );
    }
    throw err;
  }

  return c.json({ template_id: template.id, version: 1 }, 201);
});

// POST /v1/templates/:id/versions — append a new immutable version.
// `:id` accepts the template id OR its slug (matches GET /:id).
templates.post("/:id/versions", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");

  // #283 — any agent claimed to the same human as the template's owner
  // may append a version.
  const scope = await agentScope(prisma, agent);
  const template = await prisma.template.findFirst({
    where: {
      ownerId: { in: [...scope] },
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
  });
  if (!template) throw errors.artifactNotFound();
  // #305 — refuse mutation on a soft-deleted template. Restore-from-trash
  // first (the dedicated route lands in #306).
  if (template.deletedAt !== null) throw errors.softDeleted("template");

  const body = await c.req.json().catch(() => null);
  const parsed = createArtifactVersionSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }
  const {
    source,
    type,
    event_schema,
    input_schema,
    record_schema,
    template_record_schema,
  } = parsed.data;

  const eventSchema = validateVersionContent(config, {
    source,
    type,
    event_schema,
    input_schema,
    record_schema,
    template_record_schema,
  });

  if (
    config.MAX_VERSIONS_PER_ARTIFACT > 0 &&
    template.latestVersion >= config.MAX_VERSIONS_PER_ARTIFACT
  ) {
    throw errors.tooManyRequests(
      `version cap reached (max ${config.MAX_VERSIONS_PER_ARTIFACT} per template)`,
    );
  }

  const nextVersion = template.latestVersion + 1;
  await prisma.$transaction(async (tx) => {
    await tx.templateVersion.create({
      data: {
        templateId: template.id,
        version: nextVersion,
        templateType: type,
        templateSource: source,
        eventSchema:
          eventSchema !== null
            ? (eventSchema as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        inputSchema:
          input_schema !== undefined
            ? (input_schema as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        recordSchema:
          record_schema !== undefined
            ? (record_schema as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        templateRecordSchema:
          template_record_schema !== undefined
            ? (template_record_schema as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
    });
    await tx.template.update({
      where: { id: template.id },
      data: { latestVersion: nextVersion },
    });
  });

  // #267 PR C — auto-advance every "follow" install against the new
  // version. Compatible installs jump to nextVersion; incompatible ones
  // are blocked (upgradeBlockedAt + upgradeBlockedReason) so /my-templates
  // can show a "needs attention" pill. Side-effect of version publish,
  // fire-and-forget — a partial failure here doesn't roll back the
  // version-create transaction above (the version exists; we'll heal
  // installs on the next publish or via an explicit upgrade).
  await advanceFollowInstalls(prisma, template.id, nextVersion).catch(
    (err: unknown) =>
      log.warn("follow-install auto-advance batch failed", {
        templateId: template.id,
        nextVersion,
        error: err instanceof Error ? err.message : String(err),
      }),
  );

  return c.json({ template_id: template.id, version: nextVersion }, 201);
});

// Walk every active "follow" install on `templateId` and try to advance
// it to `toVersion`. For each install:
//   - Load the from + to TemplateVersion rows.
//   - Run the compat gate.
//   - Compatible → update installedVersion to toVersion, clear blocked state.
//   - Incompatible → set upgradeBlockedAt + upgradeBlockedReason. Leave
//     installedVersion where it was; the human resolves manually.
// Exported so the install-side upgrade route's tests can also exercise
// the helper directly.
export async function advanceFollowInstalls(
  prisma: PrismaClient,
  templateId: string,
  toVersion: number,
): Promise<{ advanced: number; blocked: number }> {
  const installs = await prisma.humanTemplateInstall.findMany({
    where: {
      templateId,
      upgradePolicy: "follow",
      uninstalledAt: null,
      // Already on the target? Nothing to do for this install.
      NOT: { installedVersion: toVersion },
    },
  });
  if (installs.length === 0) return { advanced: 0, blocked: 0 };

  // Cache versions we look up to avoid N round-trips when many installs
  // are on the same source version.
  const versionCache = new Map<
    number,
    {
      eventSchema: unknown;
      inputSchema: unknown;
      recordSchema: unknown;
      templateRecordSchema: unknown;
    }
  >();
  async function getVersion(v: number) {
    const cached = versionCache.get(v);
    if (cached) return cached;
    const row = await prisma.templateVersion.findUnique({
      where: { templateId_version: { templateId, version: v } },
      select: {
        eventSchema: true,
        inputSchema: true,
        recordSchema: true,
        templateRecordSchema: true,
      },
    });
    if (!row) return null;
    versionCache.set(v, row);
    return row;
  }

  const toRow = await getVersion(toVersion);
  if (!toRow) return { advanced: 0, blocked: 0 };

  let advanced = 0;
  let blocked = 0;
  const now = new Date();
  for (const install of installs) {
    const fromRow = await getVersion(install.installedVersion);
    if (!fromRow) continue;
    const breaks = comparePaneSchemas({
      oldEventSchema: fromRow.eventSchema as unknown as EventSchema | null,
      newEventSchema: toRow.eventSchema as unknown as EventSchema | null,
      oldInputSchema: fromRow.inputSchema as Record<string, unknown> | null,
      newInputSchema: toRow.inputSchema as Record<string, unknown> | null,
      oldRecordSchema: fromRow.recordSchema as Record<string, unknown> | null,
      newRecordSchema: toRow.recordSchema as Record<string, unknown> | null,
      oldTemplateRecordSchema: fromRow.templateRecordSchema as Record<
        string,
        unknown
      > | null,
      newTemplateRecordSchema: toRow.templateRecordSchema as Record<
        string,
        unknown
      > | null,
    });
    if (breaks.length === 0) {
      await prisma.humanTemplateInstall.update({
        where: { id: install.id },
        data: {
          installedVersion: toVersion,
          upgradeBlockedAt: null,
          upgradeBlockedReason: Prisma.JsonNull,
        },
      });
      advanced++;
    } else {
      await prisma.humanTemplateInstall.update({
        where: { id: install.id },
        data: {
          upgradeBlockedAt: now,
          upgradeBlockedReason: breaks as unknown as Prisma.InputJsonValue,
        },
      });
      blocked++;
    }
  }
  return { advanced, blocked };
}

// PATCH /v1/templates/:id — update head metadata only.
// `:id` accepts the template id OR its slug (matches GET /:id).
templates.patch("/:id", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");

  // #283 — any same-human agent may patch head metadata.
  const scope = await agentScope(prisma, agent);
  const template = await prisma.template.findFirst({
    where: {
      ownerId: { in: [...scope] },
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
  });
  if (!template) throw errors.artifactNotFound();
  // #305 — refuse mutation on a soft-deleted template.
  if (template.deletedAt !== null) throw errors.softDeleted("template");

  const body = await c.req.json().catch(() => null);
  const parsed = patchArtifactMetadataSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }
  const { name, slug, description, tags, icon_emoji, icon_attachment_id } =
    parsed.data;
  const data: Prisma.TemplateUpdateInput = {};
  if (name !== undefined) data.name = name;
  if (slug !== undefined) data.slug = slug;
  if (description !== undefined) data.description = description;
  if (tags !== undefined) data.tags = tags as unknown as Prisma.InputJsonValue;

  // Icon emoji: validated by the Zod schema (single grapheme). `null` clears.
  if (icon_emoji !== undefined) data.iconEmoji = icon_emoji;

  // Icon image attachment. `null` clears the pointer; a value must reference a
  // ready, raster-image, template-scoped attachment that belongs to THIS
  // template and is owned by one of the caller's same-human agents (#283
  // scope). Any miss collapses to 400/403 — never reveal a foreign id exists.
  if (icon_attachment_id !== undefined) {
    if (icon_attachment_id === null) {
      data.iconAttachment = { disconnect: true };
    } else {
      const att = await prisma.attachment.findUnique({
        where: { id: icon_attachment_id },
        select: {
          ownerId: true,
          scope: true,
          templateId: true,
          status: true,
          mime: true,
          deletedAt: true,
        },
      });
      // Opaque: a foreign / missing id is "not accessible" (403), distinct from
      // "exists and accessible but not a valid icon" (400).
      if (
        !att ||
        att.deletedAt !== null ||
        !scope.has(att.ownerId) ||
        att.scope !== "template" ||
        att.templateId !== template.id
      ) {
        throw errors.forbidden(
          "forbidden",
          "icon_attachment_id must reference a template-scoped attachment you uploaded against this template",
          "upload the image with POST /v1/attachments (scope=template, template_id=<this template>), then PATCH with the returned id",
        );
      }
      if (att.status !== "ready") {
        throw errors.invalidRequest(
          "icon_attachment_id must reference a ready (confirmed) attachment",
        );
      }
      if (!isRasterImageMime(att.mime)) {
        throw errors.invalidRequest(
          `icon_attachment_id must be a raster image (png, jpeg, webp, gif); got ${att.mime}`,
          undefined,
          "SVG and non-image attachments are rejected as icons",
        );
      }
      data.iconAttachment = { connect: { id: icon_attachment_id } };
    }
  }

  let updated;
  try {
    updated = await prisma.template.update({
      where: { id: template.id },
      data,
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw errors.conflict(
        `slug '${slug}' is already used by another of your templates`,
      );
    }
    throw err;
  }

  return c.json(summarize(updated));
});

// GET /v1/templates?q= — lean search/list of the agent's named templates.
templates.get("/", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const q = c.req.query("q")?.trim().toLowerCase();

  // Only named templates are discoverable — anonymous (inline-created) ones
  // have name = null and are an implementation detail, not browseable.
  // #283 — claimed agents see every same-human agent's templates.
  // #305 — soft-deleted templates hidden by default; ?include_deleted=true
  // exposes them for the trash UI.
  const scope = await agentScope(prisma, agent);
  const includeDeleted = parseIncludeDeleted(c);
  const rows = await prisma.template.findMany({
    where: {
      ownerId: { in: [...scope] },
      name: { not: null },
      ...softDeleteWhere(includeDeleted),
    },
    orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
  });

  let filtered = rows;
  if (q) {
    // SQLite has no FTS in the default build — fetch then filter in-process
    // over name + description + tags. The per-agent set is small (capped by
    // MAX_ARTIFACTS_PER_AGENT), so this is cheap.
    filtered = rows.filter((a) => {
      const hay = [
        a.name ?? "",
        a.description ?? "",
        ...(Array.isArray(a.tags) ? (a.tags as unknown[]).map(String) : []),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  return c.json({ templates: filtered.map(summarize) });
});

// GET /v1/templates/:id — accepts an template id OR slug. Returns the head plus
// its version list.
templates.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");

  // #283 — same-human agents share read access.
  const scope = await agentScope(prisma, agent);
  const template = await prisma.template.findFirst({
    where: {
      ownerId: { in: [...scope] },
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
    include: { versions: { orderBy: { version: "asc" } } },
  });
  if (!template) throw errors.artifactNotFound();

  return c.json({
    ...summarize(template),
    created_at: template.createdAt.toISOString(),
    updated_at: template.updatedAt.toISOString(),
    // #305 — exposes the trashed state so the trash UI can render the row.
    deleted_at: template.deletedAt?.toISOString() ?? null,
    versions: template.versions.map(serializeVersion),
  });
});

// GET /v1/templates/:id/versions/:version — one version's full content.
templates.get("/:id/versions/:version", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");
  const versionRaw = c.req.param("version");
  const version = Number(versionRaw);
  if (!Number.isInteger(version) || version < 1) {
    throw errors.invalidRequest("version must be a positive integer");
  }

  // #283 — same-human agents share read access.
  const scope = await agentScope(prisma, agent);
  const template = await prisma.template.findFirst({
    where: {
      ownerId: { in: [...scope] },
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
  });
  if (!template) throw errors.artifactNotFound();

  const v = await prisma.templateVersion.findUnique({
    where: { templateId_version: { templateId: template.id, version } },
  });
  if (!v) throw errors.artifactVersionNotFound();

  return c.json(serializeVersion(v));
});

// DELETE /v1/templates/:id — remove an template (and, via Prisma's
// onDelete:Cascade on TemplateVersion, all its versions). Strict cascade:
// the deletion is REFUSED with 409 conflict if any pane in any state
// references any version of this template. The reporter (#137) wanted a
// way to clean up test/stale templates — strict mode is the safe first
// cut: it never drops pane history that a human or operator might
// care about. Users delete the referencing panes first, then the
// template. A future PR may add a `cascade=true` flag or a separate
// "purge everything" semantic; that's a one-direction change so we
// don't want to bake it in by default.
//
// Auth: requireAgent is applied at the route group; the template must
// also belong to the calling agent. Idempotency: a second DELETE of a
// just-deleted template returns artifact_not_found (404), matching the
// pattern used by other DELETE endpoints elsewhere in the API.
templates.delete("/:id", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");

  // #283 — any same-human agent may delete the template.
  // #305 — already-soft-deleted templates resolve to 404 here. The
  // `/v1/trash/templates/:id/restore` and `/v1/trash/templates/:id`
  // permanent-delete routes (#306) own the trash side of the lifecycle;
  // this endpoint remains the live-template delete path.
  const scope = await agentScope(prisma, agent);
  const template = await prisma.template.findFirst({
    where: {
      ownerId: { in: [...scope] },
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      deletedAt: null,
    },
    select: { id: true, name: true, slug: true },
  });
  if (!template) throw errors.artifactNotFound();

  // Strict-cascade refuse: any pane (open OR closed) that pins one of
  // this template's versions blocks the delete. We count rather than fetch
  // a representative pane — the count is cheap with the index on
  // `panes.template_version_id` and the agent doesn't need pane ids
  // to act on the refusal.
  const referencingSessions = await prisma.pane.count({
    where: { templateVersion: { templateId: template.id } },
  });
  if (referencingSessions > 0) {
    throw errors.conflict(
      `template has ${referencingSessions} referencing pane(s) — delete or wait for them to expire first`,
      false,
      `run 'pane pane show <pane-id>' or 'pane pane delete <pane-id>' on each referencing pane before deleting the template; closed/expired panes count too and must be removed by the TTL sweeper or an explicit DELETE`,
    );
  }

  await prisma.template.delete({ where: { id: template.id } });
  return c.body(null, 204);
});

export default templates;
