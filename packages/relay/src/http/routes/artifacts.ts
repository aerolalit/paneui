import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import {
  createArtifactSchema,
  createArtifactVersionSchema,
  patchArtifactMetadataSchema,
} from "@pane/core";
import type { Config } from "../../config.js";
import { requireAgent, type AuthEnv } from "../auth.js";
import { errors } from "../errors.js";
import {
  assertSchemaWithinLimits,
  assertValidInputSchema,
  validateSchemaShape,
} from "../../core/validation.js";
import type { EventSchema } from "../../types.js";

const artifacts = new Hono<AuthEnv>();

artifacts.use("*", requireAgent);

// Shared validation for an artifact version's content (POST /v1/artifacts and
// POST /v1/artifacts/:id/versions). Throws an ApiError on any violation.
// Returns the normalized event schema to persist.
function validateVersionContent(
  config: Config,
  content: {
    source: string;
    type: "html-inline" | "html-ref";
    event_schema: unknown;
    input_schema?: unknown;
  },
): EventSchema {
  if (Buffer.byteLength(content.source, "utf8") > config.MAX_ARTIFACT_BYTES) {
    throw errors.payloadTooLarge();
  }
  if (content.type === "html-ref") {
    // Mirrors the session route: v1 does not serve html-ref artifacts (a blank
    // iframe with no error — issue #24). Reject at create time.
    throw errors.invalidRequest(
      "artifact type 'html-ref' is not supported in this release",
      undefined,
      "use type 'html-inline' and pass the artifact HTML in source",
    );
  }
  assertSchemaWithinLimits(content.event_schema, {
    maxBytes: config.MAX_SCHEMA_BYTES,
    maxDepth: config.MAX_SCHEMA_DEPTH,
  });
  const eventSchema = validateSchemaShape(content.event_schema);
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

// Lean summary shape for list/search — head metadata only, no source blob.
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
  artifactType: string;
  artifactSource: string;
  eventSchema: Prisma.JsonValue;
  inputSchema: Prisma.JsonValue;
  createdAt: Date;
}) {
  return {
    id: v.id,
    version: v.version,
    type: v.artifactType,
    source: v.artifactSource,
    event_schema: v.eventSchema,
    input_schema: v.inputSchema ?? null,
    created_at: v.createdAt.toISOString(),
  };
}

// POST /v1/artifacts — create a named artifact + its v1 content.
artifacts.post("/", async (c) => {
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

  // Per-agent artifact cap (count-then-create — a soft cap, see the session
  // route's identical note).
  if (config.MAX_ARTIFACTS_PER_AGENT > 0) {
    const count = await prisma.artifact.count({
      where: { ownerId: agent.id },
    });
    if (count >= config.MAX_ARTIFACTS_PER_AGENT) {
      throw errors.tooManyRequests(
        `artifact cap reached (max ${config.MAX_ARTIFACTS_PER_AGENT} per agent); delete an existing artifact before creating a new one`,
      );
    }
  }

  let artifact;
  try {
    artifact = await prisma.$transaction(async (tx) => {
      const head = await tx.artifact.create({
        data: {
          ownerId: agent.id,
          name,
          slug: slug ?? null,
          description: description ?? null,
          tags: tagsToJson(tags),
          latestVersion: 1,
        },
      });
      await tx.artifactVersion.create({
        data: {
          artifactId: head.id,
          version: 1,
          artifactType: type,
          artifactSource: source,
          eventSchema: eventSchema as unknown as Prisma.InputJsonValue,
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
        `slug '${slug}' is already used by another of your artifacts`,
      );
    }
    throw err;
  }

  return c.json({ artifact_id: artifact.id, version: 1 }, 201);
});

// POST /v1/artifacts/:id/versions — append a new immutable version.
// `:id` accepts the artifact id OR its slug (matches GET /:id).
artifacts.post("/:id/versions", async (c) => {
  const prisma = c.get("prisma");
  const config = c.get("config");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");

  const artifact = await prisma.artifact.findFirst({
    where: { ownerId: agent.id, OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
  });
  if (!artifact) throw errors.notFound();

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
    artifact.latestVersion >= config.MAX_VERSIONS_PER_ARTIFACT
  ) {
    throw errors.tooManyRequests(
      `version cap reached (max ${config.MAX_VERSIONS_PER_ARTIFACT} per artifact)`,
    );
  }

  const nextVersion = artifact.latestVersion + 1;
  await prisma.$transaction(async (tx) => {
    await tx.artifactVersion.create({
      data: {
        artifactId: artifact.id,
        version: nextVersion,
        artifactType: type,
        artifactSource: source,
        eventSchema: eventSchema as unknown as Prisma.InputJsonValue,
        inputSchema:
          input_schema !== undefined
            ? (input_schema as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
    });
    await tx.artifact.update({
      where: { id: artifact.id },
      data: { latestVersion: nextVersion },
    });
  });

  return c.json({ artifact_id: artifact.id, version: nextVersion }, 201);
});

// PATCH /v1/artifacts/:id — update head metadata only.
// `:id` accepts the artifact id OR its slug (matches GET /:id).
artifacts.patch("/:id", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");

  const artifact = await prisma.artifact.findFirst({
    where: { ownerId: agent.id, OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
  });
  if (!artifact) throw errors.notFound();

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
  const data: Prisma.ArtifactUpdateInput = {};
  if (name !== undefined) data.name = name;
  if (slug !== undefined) data.slug = slug;
  if (description !== undefined) data.description = description;
  if (tags !== undefined) data.tags = tags as unknown as Prisma.InputJsonValue;

  let updated;
  try {
    updated = await prisma.artifact.update({
      where: { id: artifact.id },
      data,
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw errors.conflict(
        `slug '${slug}' is already used by another of your artifacts`,
      );
    }
    throw err;
  }

  return c.json(summarize(updated));
});

// GET /v1/artifacts?q= — lean search/list of the agent's named artifacts.
artifacts.get("/", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const q = c.req.query("q")?.trim().toLowerCase();

  // Only named artifacts are discoverable — anonymous (inline-created) ones
  // have name = null and are an implementation detail, not browseable.
  const rows = await prisma.artifact.findMany({
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

  return c.json({ artifacts: filtered.map(summarize) });
});

// GET /v1/artifacts/:id — accepts an artifact id OR slug. Returns the head plus
// its version list.
artifacts.get("/:id", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");

  const artifact = await prisma.artifact.findFirst({
    where: {
      ownerId: agent.id,
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
    include: { versions: { orderBy: { version: "asc" } } },
  });
  if (!artifact) throw errors.notFound();

  return c.json({
    ...summarize(artifact),
    created_at: artifact.createdAt.toISOString(),
    updated_at: artifact.updatedAt.toISOString(),
    versions: artifact.versions.map(serializeVersion),
  });
});

// GET /v1/artifacts/:id/versions/:version — one version's full content.
artifacts.get("/:id/versions/:version", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");
  const versionRaw = c.req.param("version");
  const version = Number(versionRaw);
  if (!Number.isInteger(version) || version < 1) {
    throw errors.invalidRequest("version must be a positive integer");
  }

  const artifact = await prisma.artifact.findFirst({
    where: {
      ownerId: agent.id,
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
  });
  if (!artifact) throw errors.notFound();

  const v = await prisma.artifactVersion.findUnique({
    where: { artifactId_version: { artifactId: artifact.id, version } },
  });
  if (!v) throw errors.notFound();

  return c.json(serializeVersion(v));
});

export default artifacts;
