// Zod schemas for the Pane relay request shapes. These let callers (the CLI,
// other clients) validate user-supplied input — e.g. an inline JSON artifact
// or callback config — before it hits the relay, producing clear errors.

import { z } from "zod";

// The artifact `type` discriminant. `html-inline` carries raw HTML in `source`;
// `html-ref` carries a URL. The relay rejects `html-ref` in this release.
export const artifactTypeSchema = z.enum(["html-inline", "html-ref"]);

// Discriminated on `type`: both require a non-empty `source`. Kept for callers
// that want to validate a bare artifact (no event schema attached).
export const artifactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("html-inline"), source: z.string().min(1) }),
  z.object({ type: z.literal("html-ref"), source: z.string().min(1) }),
]);

export const callbackSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  secret: z.string().min(8),
});

// The inline artifact form for POST /v1/sessions — carries the event schema
// INSIDE the artifact object (one-off, no registered artifact). The relay
// transparently creates an anonymous artifact behind it.
const inlineArtifactSchema = z.object({
  source: z.string().min(1),
  type: artifactTypeSchema,
  // Optional: omit for a view-only one-off (a report/dashboard the human only
  // views — the session then accepts no page/agent events).
  event_schema: z.unknown().optional(),
});

// The reference form for POST /v1/sessions — instances an existing named
// artifact. `id` accepts the artifact id or its slug; `version` is optional
// and defaults to the artifact's latest version.
const refArtifactSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
});

// The session-create `artifact` field: exactly one of the two forms. A union
// (not a discriminated union — the two forms share no discriminant key) with a
// refine enforcing exactly-one-of `id` / `source`.
const sessionArtifactSchema = z
  .union([refArtifactSchema, inlineArtifactSchema])
  .refine(
    (a) => {
      const hasId = "id" in a && a.id !== undefined;
      const hasSource = "source" in a && a.source !== undefined;
      return hasId !== hasSource;
    },
    {
      message:
        "artifact must carry exactly one of `id` (reference an existing artifact) or `source` (inline a one-off artifact)",
    },
  );

export const createSessionSchema = z.object({
  artifact: sessionArtifactSchema,
  input_data: z.record(z.unknown()).optional(),
  participants: z.object({ humans: z.number().int().positive() }).optional(),
  ttl: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
  callback: callbackSchema.optional(),
});

// POST /v1/artifacts — create a named, reusable artifact plus its v1 content.
export const createArtifactSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  source: z.string().min(1),
  type: artifactTypeSchema,
  // Optional: omit for a view-only artifact (no event vocabulary).
  event_schema: z.unknown().optional(),
  input_schema: z.record(z.unknown()).optional(),
});

// POST /v1/artifacts/:id/versions — append a new version (content only).
export const createArtifactVersionSchema = z.object({
  source: z.string().min(1),
  type: artifactTypeSchema,
  // Optional: omit for a view-only artifact (no event vocabulary).
  event_schema: z.unknown().optional(),
  input_schema: z.record(z.unknown()).optional(),
});

// PATCH /v1/artifacts/:id — update head metadata only (never content).
export const patchArtifactMetadataSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
});

/** @deprecated use `CreateSessionRequest` from ./types.js (same type). */
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
