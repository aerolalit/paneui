// Single source of truth for the owner-UI navigation: one label and one icon
// glyph per destination, shared by EVERY nav surface so they can't drift apart.
//
// Two surfaces render navigation and used to hardcode their own labels + icons:
//   - the owner-shell SPA (owner-shell-spa.ts): sidebar + mobile bottom bar
//   - the legacy system-pages layout() (system-pages.ts): the chrome on the
//     standalone pages that don't live in the SPA (/settings, /my-agents,
//     /my-templates/:id/content)
// They disagreed on labels ("Panes" vs "My panes", "Template Store" vs
// "Template store") and even used the SAME 2x2-grid icon for two different
// destinations (Template Store in one nav, My templates in the other). This
// module makes both consume the same definitions.
//
// `NAV_GLYPHS` holds the INNER SVG markup (paths/rects/circles) only — each
// surface wraps it in its own <svg> with its own sizing/class conventions, so
// the glyph geometry is shared while each nav keeps its own styling. Authored
// on a 24x24 viewBox with `currentColor` strokes.

/** Canonical destination keys. Each surface maps its local slug to one of
 *  these (e.g. system-pages "catalog" -> "store", SPA "mine" -> "templates"). */
export type NavKey =
  | "home"
  | "panes"
  | "explore"
  | "store"
  | "templates"
  | "agents"
  | "settings"
  | "account"
  | "signout";

/** Canonical labels — sentence case, "My" prefix only where the SPA keeps it
 *  (My templates / My agents), dropped on Panes. Change a label HERE and every
 *  nav updates together. */
export const NAV_LABELS: Record<NavKey, string> = {
  home: "Home",
  panes: "Panes",
  explore: "Explore",
  store: "Template store",
  templates: "My templates",
  agents: "My agents",
  settings: "Settings",
  account: "Account",
  signout: "Sign out",
};

/** Canonical icon geometry (inner SVG markup, 24x24 viewBox, currentColor).
 *  Wrap with the surface's own <svg> element. */
export const NAV_GLYPHS: Record<NavKey, string> = {
  home: `<path d="M3 12L12 3l9 9"/><path d="M5 10v10h14V10"/>`,
  panes: `<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>`,
  // Compass — "explore the community's public panes". Distinct from the
  // storefront (Template store) and the panes rectangle so the three nav
  // destinations never read as the same icon.
  explore: `<circle cx="12" cy="12" r="9"/><polygon points="15.5 8.5 11 11 8.5 15.5 13 13 15.5 8.5"/>`,
  // Storefront/awning — distinct from the templates grid so the two never
  // read as the same destination again.
  store: `<path d="M3 3h18l-1.5 5H4.5L3 3z"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M9 12h6"/>`,
  // 2x2 grid — "my collection of templates".
  templates: `<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`,
  // Robot — an agent, not a generic person.
  agents: `<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 4v4"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>`,
  settings: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
  account: `<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>`,
  signout: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>`,
};
