// HTTP routes for template-level record collections.
//
// Mounted at /v1/templates/:id/template-records/:collection. Owner-only:
// the calling agent must own the template (or be claimed to the same human
// via agent-scope). Page-side reads land in PR B over the WS bridge — there
// is no public/HTTP read for non-owners.
//
// Auth: requireAgent. Same shape as the agent-CRUD on /v1/templates.

import { Hono } from "hono";
import { z } from "zod";
import { requireAgent, type AuthEnv } from "../auth.js";
import { agentScope } from "../agent-scope.js";
import { errors } from "../errors.js";
import {
  deleteTemplateRecord,
  listTemplateRecords,
  updateTemplateRecord,
  writeTemplateRecord,
  type TemplateWithSchema,
} from "../../core/template-records.js";

const templateRecords = new Hono<AuthEnv>();
templateRecords.use("*", requireAgent);

const MAX_RECORD_KEY_LENGTH = 256;
const DEFAULT_RECORDS_PER_PAGE = 100;

const postBody = z.object({
  record_key: z.string().min(1).max(MAX_RECORD_KEY_LENGTH).optional(),
  data: z.unknown(),
});

const patchBody = z.object({
  if_match: z.number().int().nonnegative().optional(),
  data: z.unknown(),
});

const deleteBody = z
  .object({
    if_match: z.number().int().nonnegative().optional(),
  })
  .optional();

function collectionParam(c: { req: { param: (n: string) => string } }): string {
  const name = c.req.param("collection");
  if (!name || name.length === 0) {
    throw errors.invalidRequest(":collection path parameter is required");
  }
  return name;
}

function recordKeyParam(c: { req: { param: (n: string) => string } }): string {
  const k = c.req.param("recordKey");
  if (!k || k.length === 0) {
    throw errors.invalidRequest(":recordKey path parameter is required");
  }
  return k;
}

// Loads the template head + its latest version (where templateRecordSchema
// lives) and runs the owner-scope check. The same lookup is used by every
// verb; centralise the auth + 404 here.
async function loadTemplate(
  c: import("hono").Context<AuthEnv>,
): Promise<TemplateWithSchema> {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const idOrSlug = c.req.param("id");

  const scope = await agentScope(prisma, agent);
  const template = await prisma.template.findFirst({
    where: {
      ownerId: { in: [...scope] },
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
  });
  if (!template) throw errors.templateNotFound();
  if (template.deletedAt !== null) throw errors.softDeleted("template");

  // Load the head's latest version row — templateRecordSchema lives there.
  const latestVersionRow = await prisma.templateVersion.findUnique({
    where: {
      templateId_version: {
        templateId: template.id,
        version: template.latestVersion,
      },
    },
  });
  if (!latestVersionRow) {
    // Defensive: a template head with no version is data corruption.
    throw errors.templateVersionNotFound();
  }
  return Object.assign(template, { latestVersionRow });
}

// GET /v1/templates/:id/template-records/:collection
templateRecords.get("/", async (c) => {
  const prisma = c.get("prisma");
  const template = await loadTemplate(c);
  const collection = collectionParam(c);

  let since = 0;
  const sinceRaw = c.req.query("since");
  if (sinceRaw !== undefined) {
    const n = Number(sinceRaw);
    if (!Number.isInteger(n) || n < 0) {
      throw errors.invalidRequest(
        "?since must be a non-negative integer string",
      );
    }
    since = n;
  }

  const cap = c.get("config").MAX_RECORDS_PER_PAGE;
  let limit = Math.min(DEFAULT_RECORDS_PER_PAGE, cap);
  const limitRaw = c.req.query("limit");
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > cap) {
      throw errors.invalidRequest(
        `?limit must be an integer between 1 and ${cap}`,
      );
    }
    limit = n;
  }

  const out = await listTemplateRecords(prisma, template, collection, {
    since,
    limit,
  });
  return c.json(out);
});

// POST /v1/templates/:id/template-records/:collection
templateRecords.post("/", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const template = await loadTemplate(c);
  const collection = collectionParam(c);

  const body = await c.req.json().catch(() => null);
  const parsed = postBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }

  const { record, deduped } = await writeTemplateRecord(
    { prisma, config: c.get("config") },
    template,
    // Authorship is always the agent kind here — this route is requireAgent.
    // The owner-shell cookie-authed entry point (PR D) will set kind:
    // 'human'.
    { kind: "agent", id: agent.id },
    {
      collectionName: collection,
      recordKey: parsed.data.record_key,
      data: parsed.data.data,
    },
  );

  if (deduped) {
    return c.json({ record, deduped: true }, 200);
  }
  return c.json({ record }, 201);
});

// PATCH /v1/templates/:id/template-records/:collection/:recordKey
templateRecords.patch("/:recordKey", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const template = await loadTemplate(c);
  const collection = collectionParam(c);
  const recordKey = recordKeyParam(c);

  const body = await c.req.json().catch(() => null);
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidRequest(
      "invalid body",
      parsed.error.flatten(),
      "the request body failed schema validation; details.fieldErrors lists each rejected field and why",
    );
  }

  const { record } = await updateTemplateRecord(
    { prisma, config: c.get("config") },
    template,
    { kind: "agent", id: agent.id },
    {
      collectionName: collection,
      recordKey,
      data: parsed.data.data,
      ifMatch: parsed.data.if_match,
    },
  );
  return c.json({ record });
});

// DELETE /v1/templates/:id/template-records/:collection/:recordKey
templateRecords.delete("/:recordKey", async (c) => {
  const prisma = c.get("prisma");
  const agent = c.get("agent");
  const template = await loadTemplate(c);
  const collection = collectionParam(c);
  const recordKey = recordKeyParam(c);

  let ifMatch: number | undefined;
  if (c.req.header("content-length") !== "0") {
    const body = await c.req.json().catch(() => null);
    if (body !== null) {
      const parsed = deleteBody.safeParse(body);
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
    { kind: "agent", id: agent.id },
    {
      collectionName: collection,
      recordKey,
      ifMatch,
    },
  );
  return c.body(null, 204);
});

// Method-not-allowed fallbacks mirror records.ts.
templateRecords.all("/:recordKey", (c) => {
  c.header("Allow", "PATCH, DELETE");
  throw errors.methodNotAllowed(
    `method ${c.req.method} not allowed on this route`,
    "the template-records HTTP API supports PATCH (update) and DELETE on /:recordKey",
  );
});

templateRecords.all("/", (c) => {
  c.header("Allow", "GET, POST");
  throw errors.methodNotAllowed(
    `method ${c.req.method} not allowed on this route`,
    "the template-records collection endpoint supports GET (list) and POST (create)",
  );
});

templateRecords.all("/*", () => {
  throw errors.notFound();
});

export default templateRecords;
