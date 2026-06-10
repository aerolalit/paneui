// Filter-tag helpers shared by the two template-creation paths
// (`pane template create` in http/routes/templates.ts and the inline
// `pane create --template …` form in http/routes/panes.ts).
//
// The single rule they enforce: a *named* template — and therefore every pane
// derived from it — is never untagged, so the human's Panes-tab tag filter
// always has something to slice on. Templates carry a `name` (NOT NULL since
// the require-name migration), so there is always a last-resort source for a
// tag even when the agent supplied neither `--tags` nor `--slug`.

// The human's per-pane star is a "favorite", not a tag, so these names can
// never be used as filter tags (the explicit-tag validators reject them too).
const RESERVED_TAGS = new Set(["favorite", "favorites"]);

/**
 * Derive a single filter tag from a template's name: lowercased, kebab-cased,
 * capped at 50 chars (the per-tag limit). Returns `[]` when nothing usable
 * survives — an empty result (e.g. an emoji-only name) or a reserved name — so
 * the caller leaves the template untagged rather than storing a junk tag.
 */
export function fallbackTagFromName(name: string): string[] {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, ""); // re-trim a trailing '-' the slice may have exposed
  if (!slug || RESERVED_TAGS.has(slug)) return [];
  return [slug];
}

/**
 * The tags a named template is stored with, so it (and every pane derived from
 * it) is never untagged. Precedence, first non-empty wins:
 *   1. explicit tags the agent supplied (already cleaned/validated by caller),
 *   2. the template's slug (a durable, human-chosen handle),
 *   3. a tag derived from the template's name.
 *
 * `cleaned` MUST already be trimmed, deduped, and reserved-checked by the
 * caller — this function only chooses *which* source to use, it does not
 * re-validate.
 */
export function templateTagsWithFallback(
  cleaned: string[],
  name: string,
  slug: string | null | undefined,
): string[] {
  if (cleaned.length > 0) return cleaned;
  if (slug) return [slug];
  return fallbackTagFromName(name);
}
