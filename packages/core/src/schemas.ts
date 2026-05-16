// Zod schemas for the Pane relay request shapes. These let callers (the CLI,
// other clients) validate user-supplied input — e.g. an inline JSON artifact
// or callback config — before it hits the relay, producing clear errors.

import { z } from "zod";

// Discriminated on `type`: `html-ref`'s `source` is a URL, `html-inline`'s is
// raw HTML. Both require a non-empty `source`; the relay enforces URL safety.
export const artifactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("html-inline"), source: z.string().min(1) }),
  z.object({ type: z.literal("html-ref"), source: z.string().min(1) }),
]);

export const callbackSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  secret: z.string().min(8),
});

export const createSessionSchema = z.object({
  artifact: artifactSchema,
  schema: z.unknown(),
  participants: z.object({ humans: z.number().int().positive() }).optional(),
  ttl: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
  callback: callbackSchema.optional(),
});

/** @deprecated use `CreateSessionRequest` from ./types.js (same type). */
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
