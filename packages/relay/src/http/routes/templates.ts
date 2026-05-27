import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import {
  createArtifactSchema,
  createArtifactVersionSchema,
  patchArtifactMetadataSchema,
} from "@paneui/core";
import type { Config } from "../../config.js";
import { requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import {
  assertSchemaWithinLimits,
  assertValidInputSchema,
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
  },
): EventSchema | null {
  if (Buffer.byteLength(content.source, "utf8") > config.MAX_ARTIFACT_BYTES) {
    throw errors.payloadTooLarge();
  }
  if (content.type === "html-ref") {
    // Mirrors the surface route: v1 does not serve html-ref templates (a blank
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
  } = parsed.data;

  const eventSchema = validateVersionContent(config, {
    source,
    type,
    event_schema,
    input_schema,
  });

  // Per-agent template cap (count-then-create — a soft cap, see the surface
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

  const template = await prisma.template.findFirst({
    where: { ownerId: agent.id, OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
  });
  if (!template) throw errors.artifactNotFound();

  const body = await c.req.json().catch(() => null);
  const parsed = createArtifactVersionSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }
  const { source, type, event_schema, input_schema } = parsed.data;

  const eventSchema = validateVersionContent(config, {
    source,
    type,
    event_schema,
    input_schema,
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
      },
    });
    await tx.template.update({
      where: { id: template.id },
      data: { latestVersion: nextVersion },
    });
  });

  return c.json({ template_id: template.id, version: nextVersion }, 201);
});

// PATCH /v1/templates/:id — update head metadata only.
// `:id` accepts the template id OR its slug (matches GET /:id).
templates.patch("/:id", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");

  const template = await prisma.template.findFirst({
    where: { ownerId: agent.id, OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
  });
  if (!template) throw errors.artifactNotFound();

  const body = await c.req.json().catch(() => null);
  const parsed = patchArtifactMetadataSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }
  const { name, slug, description, tags } = parsed.data;
  const data: Prisma.TemplateUpdateInput = {};
  if (name !== undefined) data.name = name;
  if (slug !== undefined) data.slug = slug;
  if (description !== undefined) data.description = description;
  if (tags !== undefined) data.tags = tags as unknown as Prisma.InputJsonValue;

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
  const rows = await prisma.template.findMany({
    where: { ownerId: agent.id, name: { not: null } },
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

  const template = await prisma.template.findFirst({
    where: {
      ownerId: agent.id,
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
    include: { versions: { orderBy: { version: "asc" } } },
  });
  if (!template) throw errors.artifactNotFound();

  return c.json({
    ...summarize(template),
    created_at: template.createdAt.toISOString(),
    updated_at: template.updatedAt.toISOString(),
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

  const template = await prisma.template.findFirst({
    where: {
      ownerId: agent.id,
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
// the deletion is REFUSED with 409 conflict if any surface in any state
// references any version of this template. The reporter (#137) wanted a
// way to clean up test/stale templates — strict mode is the safe first
// cut: it never drops surface history that a human or operator might
// care about. Users delete the referencing surfaces first, then the
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

  const template = await prisma.template.findFirst({
    where: { ownerId: agent.id, OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    select: { id: true, name: true, slug: true },
  });
  if (!template) throw errors.artifactNotFound();

  // Strict-cascade refuse: any surface (open OR closed) that pins one of
  // this template's versions blocks the delete. We count rather than fetch
  // a representative surface — the count is cheap with the index on
  // `surfaces.template_version_id` and the agent doesn't need surface ids
  // to act on the refusal.
  const referencingSessions = await prisma.surface.count({
    where: { templateVersion: { templateId: template.id } },
  });
  if (referencingSessions > 0) {
    throw errors.conflict(
      `template has ${referencingSessions} referencing surface(s) — delete or wait for them to expire first`,
      false,
      `run 'pane surface show <surface-id>' or 'pane surface delete <surface-id>' on each referencing surface before deleting the template; closed/expired surfaces count too and must be removed by the TTL sweeper or an explicit DELETE`,
    );
  }

  await prisma.template.delete({ where: { id: template.id } });
  return c.body(null, 204);
});

export default templates;
