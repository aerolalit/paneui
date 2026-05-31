// Shared seed helpers for tests. Since the reusable-templates change, a surface
// is FK'd to an `template_version` rather than carrying inline template columns
// — so a raw `prisma.surface.create` must first create an Template + an
// TemplateVersion. These helpers encapsulate that two-step setup.

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** A minimal, valid event schema usable by any test that does not care. */
export const minimalEventSchema = {
  events: {
    "test.event": {
      payload: { type: "object" },
      emittedBy: ["page", "agent"],
    },
  },
};

export interface SeedArtifactOptions {
  ownerId: string;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  tags?: string[] | null;
  templateType?: string;
  templateSource?: string;
  eventSchema?: object;
  inputSchema?: object | null;
}

/**
 * Create an Template head + one TemplateVersion (v1). Returns both ids.
 * Used by tests that need a concrete `template_version_id` to attach a surface
 * to.
 */
export async function seedArtifact(
  prisma: PrismaClient,
  opts: SeedArtifactOptions,
): Promise<{ templateId: string; templateVersionId: string }> {
  const template = await prisma.template.create({
    data: {
      ownerId: opts.ownerId,
      name: opts.name ?? null,
      slug: opts.slug ?? null,
      description: opts.description ?? null,
      tags: opts.tags ?? undefined,
      latestVersion: 1,
    },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      templateType: opts.templateType ?? "html-inline",
      templateSource: opts.templateSource ?? "<html></html>",
      eventSchema: (opts.eventSchema ?? minimalEventSchema) as object,
      inputSchema: opts.inputSchema ?? undefined,
    },
  });
  return { templateId: template.id, templateVersionId: version.id };
}

export interface SeedSurfaceOptions {
  agentId: string;
  id?: string;
  status?: "open" | "closed";
  expiresAt?: Date;
  metadata?: object | null;
  inputData?: object | null;
  callbackUrl?: string | null;
  callbackSecretEnc?: string | null;
  callbackFilter?: string[] | null;
  templateType?: string;
  templateSource?: string;
  eventSchema?: object;
  inputSchema?: object | null;
  /** Per-surface tab title. Defaults to a benign placeholder; tests exercising
   * the bridge shell's <title> rendering pass their own value. */
  title?: string;
  /** Optional context preamble — passes through to Surface.preamble. */
  preamble?: string | null;
  /** Reuse an existing template version instead of creating a fresh one. */
  templateVersionId?: string;
}

/**
 * Create a surface row, transparently seeding an Template + TemplateVersion
 * first (unless `templateVersionId` is supplied). Returns the surface id and
 * the template-version id it was pinned to.
 */
export async function seedSurfaceRow(
  prisma: PrismaClient,
  opts: SeedSurfaceOptions,
): Promise<{ surfaceId: string; templateVersionId: string }> {
  let templateVersionId = opts.templateVersionId;
  if (!templateVersionId) {
    const seeded = await seedArtifact(prisma, {
      ownerId: opts.agentId,
      templateType: opts.templateType,
      templateSource: opts.templateSource,
      eventSchema: opts.eventSchema,
      inputSchema: opts.inputSchema,
    });
    templateVersionId = seeded.templateVersionId;
  }
  const surfaceId = opts.id ?? `sur_${randomBytes(8).toString("hex")}`;
  await prisma.surface.create({
    data: {
      id: surfaceId,
      agentId: opts.agentId,
      templateVersionId,
      title: opts.title ?? "Pane Surface",
      preamble: opts.preamble ?? null,
      status: opts.status ?? "open",
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 3_600_000),
      metadata: opts.metadata ?? undefined,
      inputData: opts.inputData ?? undefined,
      callbackUrl: opts.callbackUrl ?? null,
      callbackSecretEnc: opts.callbackSecretEnc ?? null,
      callbackFilter: opts.callbackFilter ?? undefined,
    },
  });
  return { surfaceId, templateVersionId };
}
