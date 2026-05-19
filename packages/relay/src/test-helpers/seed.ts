// Shared seed helpers for tests. Since the reusable-artifacts change, a session
// is FK'd to an `artifact_version` rather than carrying inline artifact columns
// — so a raw `prisma.session.create` must first create an Artifact + an
// ArtifactVersion. These helpers encapsulate that two-step setup.

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
  artifactType?: string;
  artifactSource?: string;
  eventSchema?: object;
  inputSchema?: object | null;
}

/**
 * Create an Artifact head + one ArtifactVersion (v1). Returns both ids.
 * Used by tests that need a concrete `artifact_version_id` to attach a session
 * to.
 */
export async function seedArtifact(
  prisma: PrismaClient,
  opts: SeedArtifactOptions,
): Promise<{ artifactId: string; artifactVersionId: string }> {
  const artifact = await prisma.artifact.create({
    data: {
      ownerId: opts.ownerId,
      name: opts.name ?? null,
      slug: opts.slug ?? null,
      description: opts.description ?? null,
      tags: opts.tags ?? undefined,
      latestVersion: 1,
    },
  });
  const version = await prisma.artifactVersion.create({
    data: {
      artifactId: artifact.id,
      version: 1,
      artifactType: opts.artifactType ?? "html-inline",
      artifactSource: opts.artifactSource ?? "<html></html>",
      eventSchema: (opts.eventSchema ?? minimalEventSchema) as object,
      inputSchema: opts.inputSchema ?? undefined,
    },
  });
  return { artifactId: artifact.id, artifactVersionId: version.id };
}

export interface SeedSessionOptions {
  agentId: string;
  id?: string;
  status?: "open" | "closed";
  expiresAt?: Date;
  metadata?: object | null;
  inputData?: object | null;
  callbackUrl?: string | null;
  callbackSecretEnc?: string | null;
  callbackFilter?: string[] | null;
  artifactType?: string;
  artifactSource?: string;
  eventSchema?: object;
  inputSchema?: object | null;
  /** Reuse an existing artifact version instead of creating a fresh one. */
  artifactVersionId?: string;
}

/**
 * Create a session row, transparently seeding an Artifact + ArtifactVersion
 * first (unless `artifactVersionId` is supplied). Returns the session id and
 * the artifact-version id it was pinned to.
 */
export async function seedSessionRow(
  prisma: PrismaClient,
  opts: SeedSessionOptions,
): Promise<{ sessionId: string; artifactVersionId: string }> {
  let artifactVersionId = opts.artifactVersionId;
  if (!artifactVersionId) {
    const seeded = await seedArtifact(prisma, {
      ownerId: opts.agentId,
      artifactType: opts.artifactType,
      artifactSource: opts.artifactSource,
      eventSchema: opts.eventSchema,
      inputSchema: opts.inputSchema,
    });
    artifactVersionId = seeded.artifactVersionId;
  }
  const sessionId = opts.id ?? `ses_${randomBytes(8).toString("hex")}`;
  await prisma.session.create({
    data: {
      id: sessionId,
      agentId: opts.agentId,
      artifactVersionId,
      status: opts.status ?? "open",
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 3_600_000),
      metadata: opts.metadata ?? undefined,
      inputData: opts.inputData ?? undefined,
      callbackUrl: opts.callbackUrl ?? null,
      callbackSecretEnc: opts.callbackSecretEnc ?? null,
      callbackFilter: opts.callbackFilter ?? undefined,
    },
  });
  return { sessionId, artifactVersionId };
}
