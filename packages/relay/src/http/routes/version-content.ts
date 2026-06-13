// Shared validation for a template version's content — used by the template
// version-append routes (POST /v1/templates, POST /v1/templates/:id/versions)
// AND the inline pane-upgrade path (POST /v1/panes/:id/upgrade with a
// `template`), so all three apply identical content rules. Throws an ApiError
// on any violation. Returns the normalized event schema to persist, or `null`
// when the version declares no event schema — a view-only template
// (report/dashboard/chart) the human only views. A present-but-malformed schema
// is still rejected.

import type { Config } from "../../config.js";
import { errors } from "../errors.js";
import {
  assertSchemaWithinLimits,
  assertValidInputSchema,
  validateRecordSchemaShape,
  validateSchemaShape,
} from "../../core/validation.js";
import type { EventSchema } from "../../types.js";

export function validateVersionContent(
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
