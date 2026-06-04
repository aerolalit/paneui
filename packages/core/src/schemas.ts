// Zod schemas for the Pane relay request shapes. These let callers (the CLI,
// other clients) validate user-supplied input — e.g. an inline JSON template
// or callback config — before it hits the relay, producing clear errors.

import { z } from "zod";
import { validateIconEmoji } from "./icons.js";

// A validated icon emoji: exactly one emoji grapheme (see ./icons.ts). Used in
// template/pane create + patch payloads. Rejects letters/digits/control chars
// and multi-grapheme strings with a clear message.
const iconEmojiSchema = z.string().refine((s) => validateIconEmoji(s).ok, {
  message: "icon_emoji must be exactly one emoji (a single grapheme)",
});

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

// The inline template form for POST /v1/panes — carries the event schema
// INSIDE the template object (one-off, no registered template). The relay
// transparently creates an anonymous template behind it.
const inlineArtifactSchema = z.object({
  source: z.string().min(1),
  type: artifactTypeSchema,
  // Optional: omit for a view-only one-off (a report/dashboard the human only
  // views — the pane then accepts no page/agent events).
  event_schema: z.unknown().optional(),
  // Optional: when present, the pane's `input_data` is validated against
  // this JSON Schema before the pane row is created — and any attachment refs
  // declared at `format: pane-attachment-id` sites become reachable from the page
  // via `window.pane.downloadBlob()`. Without this, attachment refs in
  // `input_data` are silently unreachable for inline panes (the
  // participant attachment-download bridge walks input_data against the template
  // version's inputSchema; no schema means no walkable sites). See #208.
  input_schema: z.record(z.string(), z.unknown()).optional(),
  // Optional JSON Schema 2020-12 document with an `x-pane-collections`
  // extension declaring the template's record collections (#287 / #289).
  // Validated by the relay at create time. Persistence ships once the
  // schema migration (#288) lands.
  record_schema: z.unknown().optional(),
});

// The reference form for POST /v1/panes — instances an existing named
// template. `id` accepts the template id or its slug; `version` is optional
// and defaults to the template's latest version.
const refArtifactSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
});

// The pane-create `template` field: exactly one of the two forms. A union
// (not a discriminated union — the two forms share no discriminant key) with a
// refine enforcing exactly-one-of `id` / `source`.
const paneTemplateSchema = z
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

export const createPaneSchema = z.object({
  template: paneTemplateSchema,
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
  // Optional context preamble shown in the shell band above the iframe so the
  // human reads "who is asking, why" before the artifact. Wire cap is 300 to
  // leave the relay's trimmed 280-char rejection as the one callers see.
  preamble: z.string().max(300).optional(),
  // Phase G — natural-key dedup. When set, the relay collapses repeated
  // creates with the same (template, owner, context_key) into one pane
  // row. NULL = ad-hoc, no dedup. See HUMAN-SIDE-PROPOSAL.md §7.1.
  context_key: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_:.-]+$/, "context_key must be a short identifier")
    .optional(),
  // Per-pane icon override. `icon_emoji` is a single emoji grapheme;
  // `icon_attachment_id` references a ready, agent-accessible raster image
  // attachment (validated server-side). NULL/absent = inherit the template's
  // icon. NO external URLs.
  icon_emoji: iconEmojiSchema.optional(),
  icon_attachment_id: z.string().min(1).optional(),
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
  // Optional records declaration (#287 / #289). See inlineArtifactSchema above.
  record_schema: z.unknown().optional(),
  // Optional template-level records declaration. Same JSON Schema 2020-12 +
  // x-pane-collections grammar as record_schema; stored separately on the
  // version so the publisher can curate shared content visible to every
  // derived pane.
  template_record_schema: z.unknown().optional(),
  // Optional template icon emoji (a single emoji grapheme). Image icons are
  // set post-create via PATCH /v1/templates/:id, since the uploaded
  // attachment must reference this template's id first.
  icon_emoji: iconEmojiSchema.optional(),
});

// POST /v1/templates/:id/versions — append a new version (content only).
export const createArtifactVersionSchema = z.object({
  source: z.string().min(1),
  type: artifactTypeSchema,
  // Optional: omit for a view-only template (no event vocabulary).
  event_schema: z.unknown().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  // Optional records declaration (#287 / #289). See inlineArtifactSchema above.
  record_schema: z.unknown().optional(),
  // Optional template-level records declaration. Same grammar as record_schema.
  template_record_schema: z.unknown().optional(),
});

// PATCH /v1/templates/:id — update head metadata only (never content).
export const patchArtifactMetadataSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  // Template icon. Pass a single emoji grapheme (icon_emoji) or a ready,
  // template-scoped raster image attachment id (icon_attachment_id). Pass
  // `null` to CLEAR that side. Setting an image and an emoji are independent —
  // the renderer prefers the image when both are present. NO external URLs.
  icon_emoji: iconEmojiSchema.nullable().optional(),
  icon_attachment_id: z.string().min(1).nullable().optional(),
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
  pane_id: z.string().min(1).optional(),
});

/** @deprecated use `CreatePaneRequest` from ./types.js (same type). */
export type CreatePaneInput = z.infer<typeof createPaneSchema>;

// GET /v1/panes — list the calling agent's panes. The relay also
// re-parses these on its side (defence in depth); this schema is for the CLI
// to fail fast with a clear error before a round trip.
export const listPanesStatusSchema = z.enum(["open", "closed", "all"]);
export type ListPanesStatus = z.infer<typeof listPanesStatusSchema>;

export const listPanesQuerySchema = z.object({
  status: listPanesStatusSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().min(1).optional(),
  template_id: z.string().min(1).optional(),
});
export type ListPanesQuery = z.infer<typeof listPanesQuerySchema>;

// POST /v1/panes/:id/participants — mint a fresh participant URL for an
// existing pane. v1 supports human participants only (the agent token is
// minted at pane-create and cannot be re-minted via this endpoint).
export const mintParticipantSchema = z.object({
  kind: z.literal("human"),
});
export type MintParticipantInput = z.infer<typeof mintParticipantSchema>;

// POST /v1/panes/:id/upgrade — re-pin a live pane to a newer version
// of the same template (#267). `template_version` is optional; the relay
// defaults to the template's latest version. `compat` defaults to "strict",
// which makes the relay refuse 422 if the target schema isn't a superset
// of the current one (events written under the old schema would no longer
// validate). "force" overrides the gate — used sparingly when the operator
// knows data loss is acceptable.
export const upgradePaneSchema = z.object({
  template_version: z.number().int().positive().optional(),
  compat: z.enum(["strict", "force"]).optional(),
});
export type UpgradePaneInput = z.infer<typeof upgradePaneSchema>;
