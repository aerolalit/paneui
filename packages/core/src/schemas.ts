// Zod schemas for the Pane relay request shapes. These let callers (the CLI,
// other clients) validate user-supplied input — e.g. an inline JSON template
// or callback config — before it hits the relay, producing clear errors.

import { z } from "zod";

// The template `type` discriminant. `html-inline` carries raw HTML in `source`;
// `html-ref` carries a URL. The relay rejects `html-ref` in this release.
export const artifactTypeSchema = z.enum(["html-inline", "html-ref"]);

// Discriminated on `type`: both require a non-empty `source`. Kept for callers
// that want to validate a bare template (no event schema attached).
export const artifactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("html-inline"), source: z.string().min(1) }),
  z.object({ type: z.literal("html-ref"), source: z.string().min(1) }),
]);

export const callbackSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  secret: z.string().min(8),
});

// The inline template form for POST /v1/surfaces — carries the event schema
// INSIDE the template object (one-off, no registered template). The relay
// transparently creates an anonymous template behind it.
const inlineArtifactSchema = z.object({
  source: z.string().min(1),
  type: artifactTypeSchema,
  // Optional: omit for a view-only one-off (a report/dashboard the human only
  // views — the surface then accepts no page/agent events).
  event_schema: z.unknown().optional(),
  // Optional: when present, the surface's `input_data` is validated against
  // this JSON Schema before the surface row is created — and any attachment refs
  // declared at `format: pane-attachment-id` sites become reachable from the page
  // via `window.pane.downloadBlob()`. Without this, attachment refs in
  // `input_data` are silently unreachable for inline surfaces (the
  // participant attachment-download bridge walks input_data against the template
  // version's inputSchema; no schema means no walkable sites). See #208.
  input_schema: z.record(z.string(), z.unknown()).optional(),
});

// The reference form for POST /v1/surfaces — instances an existing named
// template. `id` accepts the template id or its slug; `version` is optional
// and defaults to the template's latest version.
const refArtifactSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
});

// The surface-create `template` field: exactly one of the two forms. A union
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
        "template must carry exactly one of `id` (reference an existing template) or `source` (inline a one-off template)",
    },
  );

export const createSessionSchema = z.object({
  template: sessionArtifactSchema,
  input_data: z.record(z.string(), z.unknown()).optional(),
  participants: z.object({ humans: z.number().int().positive() }).optional(),
  ttl: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  callback: callbackSchema.optional(),
  // Tab title for the human's browser. Optional on the wire because the relay
  // also accepts the implicit fallback (an Template.name on the reference
  // form). The relay enforces "required-or-fallback" + length/control-char
  // rules — Zod only confirms it's a string here.
  title: z.string().optional(),
});

// POST /v1/templates — create a named, reusable template plus its v1 content.
export const createArtifactSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  source: z.string().min(1),
  type: artifactTypeSchema,
  // Optional: omit for a view-only template (no event vocabulary).
  event_schema: z.unknown().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
});

// POST /v1/templates/:id/versions — append a new version (content only).
export const createArtifactVersionSchema = z.object({
  source: z.string().min(1),
  type: artifactTypeSchema,
  // Optional: omit for a view-only template (no event vocabulary).
  event_schema: z.unknown().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
});

// PATCH /v1/templates/:id — update head metadata only (never content).
export const patchArtifactMetadataSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
});

// POST /v1/feedback — an agent submits a bug report, feature request, or note
// to the relay operator. Message is trimmed before length check so whitespace
// padding cannot bypass the 1..4000 cap.
export const feedbackTypeSchema = z.enum(["bug", "feature", "note"]);

export const submitFeedbackSchema = z.object({
  type: feedbackTypeSchema,
  message: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(4000)),
  surface_id: z.string().min(1).optional(),
});

/** @deprecated use `CreateSessionRequest` from ./types.js (same type). */
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

// GET /v1/surfaces — list the calling agent's surfaces. The relay also
// re-parses these on its side (defence in depth); this schema is for the CLI
// to fail fast with a clear error before a round trip.
export const listSessionsStatusSchema = z.enum(["open", "closed", "all"]);
export type ListSessionsStatus = z.infer<typeof listSessionsStatusSchema>;

export const listSessionsQuerySchema = z.object({
  status: listSessionsStatusSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().min(1).optional(),
  template_id: z.string().min(1).optional(),
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

// POST /v1/surfaces/:id/participants — mint a fresh participant URL for an
// existing surface. v1 supports human participants only (the agent token is
// minted at surface-create and cannot be re-minted via this endpoint).
export const mintParticipantSchema = z.object({
  kind: z.literal("human"),
});
export type MintParticipantInput = z.infer<typeof mintParticipantSchema>;
