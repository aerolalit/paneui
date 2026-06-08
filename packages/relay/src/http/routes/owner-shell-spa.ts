// Owner-shell SPA — the new /home, replacing the per-route Phase D pages
// (/home, /my-panes, /my-templates, /template-store, /trash) with one
// single-page-app shell that matches the prototype at
// /panes/pan_J5ZUOt_xL7UbZDNZ (source: /tmp/demo-template.html).
//
// Architecture decision: ALL view data is server-rendered into the
// initial HTML. No per-view client fetches. The SPA's job is purely
// presentational — swap `.active` on `.view`, sync the URL hash,
// filter visible items as the user types. This means:
//   - First paint shows real data immediately, no shell-then-hydrate flash.
//   - View switching is instant (no network).
//   - Refreshing the page re-fetches from the server (good — picks up
//     anything an agent created in the background).
//
// The CSS is verbatim from the prototype (./owner-shell-css.ts).

import type { PrismaClient } from "@prisma/client";
import type { Human as HumanRow } from "@prisma/client";
import { OWNER_SHELL_CSS } from "./owner-shell-css.js";
import { BRAND_FAVICON_DATA_HREF, BRAND_LOGO } from "../../brand.js";
import { NAV_GLYPHS, NAV_LABELS, type NavKey } from "./nav-meta.js";
import { hasRequiredInputSchema } from "../../core/validation.js";
import { filterByOpenPaneCount } from "./templates.js";
import type { Config } from "../../config.js";

// Wrap a shared nav glyph (nav-meta.ts) in the SPA's <svg> conventions so the
// sidebar / account / mobile-bar icons stay byte-identical to the legacy
// system-pages tab icons — one source of truth, no drift. `size` is px.
function spaIco(key: NavKey, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_GLYPHS[key]}</svg>`;
}

// ----- Public entry: serve the SPA -----

export interface OwnerShellOptions {
  prisma: PrismaClient;
  config: Config;
  human: HumanRow;
  /** Per-request CSP nonce — stamped on the SPA's inline <style>/<script> so
   *  the /home response can drop `script-src 'unsafe-inline'`. */
  nonce: string;
}

export async function renderOwnerShell(
  opts: OwnerShellOptions,
): Promise<string> {
  const data = await loadShellData(opts.prisma, opts.config, opts.human);
  return renderHtml(opts.human, data, opts.nonce);
}

// ----- Data shapes (all post-Prisma, ready to render) -----

interface TemplateRef {
  id: string;
  name: string | null;
  slug: string | null;
  /** True when the template's latest version declares a non-empty
   *  input_schema with required fields — i.e. it needs an agent (or
   *  some out-of-band caller) to seed input_data before it's useful. */
  isAgentInit: boolean;
  /** Number of live panes the human has derived from this template.
   *  Drives the "X panes →" chip on My templates tiles that jumps to the
   *  Panes view filtered to this template. */
  paneCount: number;
  /** True when the human owns this template AND it's currently published
   *  to the public catalog. Drives the Publish/Unpublish toggle in the
   *  tile menu. Always false for installed-only or discover tiles. */
  isPublished: boolean;
  /** Single-grapheme emoji icon, or null. Rendered inline as text when the
   *  template has no image icon. */
  iconEmoji: string | null;
  /** True when the template has an uploaded image icon — served at
   *  /templates/:id/icon. Takes precedence over the emoji + monogram. */
  hasIconImage: boolean;
  /** Required input_data fields (name + JSON type) of an agent-init
   *  template's latest version, derived from its input_schema `required`
   *  list. Powers the copy-paste agent instructions shown when a human taps
   *  an agent-init tile. Empty for non-agent-init templates. */
  agentInitFields: Array<{ name: string; type: string }>;
  /** Author-supplied prose description. Surfaced on the store detail modal.
   *  Only populated for catalog (store) refs; null elsewhere. */
  description: string | null;
  /** Free-form tags. Surfaced on the store detail modal. */
  tags: string[];
  /** Latest version number. Surfaced on the store detail modal. */
  version: number;
  /** How many humans have installed this template. Surfaced on the store
   *  detail modal. */
  installCount: number;
}

interface PaneRef {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  /** Access mode: "invite_only" | "link" | "public". Drives the row's
   *  visibility icon. */
  accessMode: string;
  /** Filter tags (template snapshot + per-pane extras). Drives the tag chips. */
  tags: string[];
  templateId: string | null;
  templateVersion: number;
  templateName: string | null;
  /** True when this pane is starred by the human. Drives the Home
   *  Favorites strip and the star toggle on each pane row. */
  isFavorite: boolean;
  /** Effective emoji icon (pane override else the template's), or null. */
  iconEmoji: string | null;
  /** True when the pane has an EFFECTIVE image icon (pane override else the
   *  template's) — served at /panes/:id/icon. */
  hasIconImage: boolean;
}

/** A pane somebody has marked public (Pane.accessMode === "public"). Shown in
 *  the Explore view — a community gallery of read-only-viewable panes from ANY
 *  owner, not just the logged-in human's. Distinct from PaneRef: it carries the sharer's
 *  handle + a viewer count, and deliberately omits favorite/template-filter
 *  affordances (those mutate the viewer's own library, which makes no sense for
 *  someone else's pane). */
interface PublicPaneRef {
  id: string;
  title: string;
  /** True when the pane is open and not past its TTL — the "live" pill. */
  isLive: boolean;
  createdAt: Date;
  /** Display name of whoever shared it ("@alice", an agent name, or a
   *  fallback). Never an email — friendlyName() strips the domain. */
  sharedBy: string;
  /** Distinct humans who have opened it (HumanPaneView ledger count). */
  viewerCount: number;
  /** Effective emoji icon (pane override else template's), or null. The
   *  Explore row uses the gradient monogram fallback when null — it never
   *  links the owner-gated /panes/:id/icon image, which a non-owner viewer
   *  couldn't load anyway. */
  iconEmoji: string | null;
  /** Template display name, for the row's secondary line. */
  templateName: string | null;
}

interface ShellData {
  /** Templates owned by one of the human's claimed agents (live only). */
  ownedTemplates: TemplateRef[];
  /** HumanTemplateInstall rows joined with their Template. */
  installs: Array<{
    template: TemplateRef;
    installedVersion: number;
  }>;
  /** Public catalog rows (excluding things already installed). */
  publicCatalog: TemplateRef[];
  /** Panes the human owns or has joined as participant, ordered newest first. */
  panes: PaneRef[];
  /** Subset of `panes` the human has starred. Home Favorites strip
   *  renders these as openable pane cards. */
  favoritePanes: PaneRef[];
  /** Public panes from ANY owner — the Explore community gallery. */
  publicPanes: PublicPaneRef[];
  /** True once the human has claimed at least one agent. Drives the
   *  first-run "connect your first agent" nudge on Home. */
  hasClaimedAgents: boolean;
  /** The human's claimed agents (non-trashed), for the Agents view. */
  agents: AgentRow[];
}

interface AgentRow {
  id: string;
  name: string;
  keyPrefix: string;
  /** ISO date (YYYY-MM-DD) the agent was claimed, or null. */
  claimedAt: string | null;
  /** Relative "last used" string ("never" when unused). */
  lastUsed: string;
  /** True when the agent's key has been revoked (still listed, inert). */
  revoked: boolean;
}

async function loadShellData(
  prisma: PrismaClient,
  config: Config,
  human: HumanRow,
): Promise<ShellData> {
  // One human owns N claimed agents; their templates are the "Yours"
  // section under My templates.
  const claimedAgents = await prisma.agent.findMany({
    where: { ownerHumanId: human.id, deletedAt: null },
    orderBy: { claimedAt: { sort: "desc", nulls: "last" } },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      claimedAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
  const claimedAgentIds = claimedAgents.map((a) => a.id);

  // Latest-version input_schema include — used to compute isAgentInit
  // for every template returned below. One sub-query per template; cheap
  // enough at shell-render scale (handful of rows).
  const latestVersionInclude = {
    versions: {
      orderBy: { version: "desc" as const },
      take: 1,
      select: { inputSchema: true },
    },
  };

  const [
    ownedTemplatesRaw,
    installs,
    publicCatalogRaw,
    panesRaw,
    favoriteRows,
    publicPanesRaw,
  ] = await Promise.all([
    claimedAgentIds.length === 0
      ? Promise.resolve([])
      : prisma.template.findMany({
          where: {
            ownerId: { in: claimedAgentIds },
            deletedAt: null,
          },
          orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
          select: {
            id: true,
            name: true,
            slug: true,
            publishedAt: true,
            iconEmoji: true,
            iconAttachmentId: true,
            ...latestVersionInclude,
          },
        }),
    prisma.humanTemplateInstall.findMany({
      where: { humanId: human.id, uninstalledAt: null },
      orderBy: { installedAt: "desc" },
      select: {
        installedVersion: true,
        template: {
          select: {
            id: true,
            name: true,
            slug: true,
            publishedAt: true,
            deletedAt: true,
            iconEmoji: true,
            iconAttachmentId: true,
            ...latestVersionInclude,
          },
        },
      },
    }),
    prisma.template.findMany({
      where: { publishedAt: { not: null }, deletedAt: null },
      orderBy: [{ installCount: "desc" }, { publishedAt: "desc" }],
      take: 40,
      select: {
        id: true,
        name: true,
        slug: true,
        publishedAt: true,
        iconEmoji: true,
        iconAttachmentId: true,
        // Detail-page fields — surfaced in the store template detail modal.
        description: true,
        tags: true,
        latestVersion: true,
        installCount: true,
        ...latestVersionInclude,
      },
    }),
    prisma.pane.findMany({
      where: {
        deletedAt: null,
        OR: [
          { ownerHumanId: human.id },
          {
            participants: {
              some: { humanId: human.id, revokedAt: null },
            },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        expiresAt: true,
        // Access mode (invite_only | link | public) — drives the visibility
        // icon on each pane row.
        accessMode: true,
        // Filter tags (snapshot from the template + per-pane extras) — drive
        // the Panes-tab tag chips.
        tags: true,
        // Per-pane icon override (NULL = inherit the template's icon).
        iconEmoji: true,
        iconAttachmentId: true,
        templateVersion: {
          select: {
            version: true,
            template: {
              select: {
                id: true,
                name: true,
                slug: true,
                // Template's icon — the fallback when the pane has no override.
                iconEmoji: true,
                iconAttachmentId: true,
              },
            },
          },
        },
      },
    }),
    prisma.humanPaneFavorite.findMany({
      where: { humanId: human.id, pane: { deletedAt: null } },
      orderBy: { addedAt: "desc" },
      select: { paneId: true },
    }),
    // Explore — public panes from EVERY owner (the gallery), not scoped to the
    // logged-in human. accessMode "public" is the discovery gate: per the
    // Pane.accessMode contract, only "public" panes may be LISTED — "link"
    // panes are shareable by URL but deliberately not discoverable, and
    // "invite_only" is gated entirely. deletedAt filters trashed rows. Newest
    // first, capped — this is a browse surface, not a full index.
    prisma.pane.findMany({
      where: { accessMode: "public", deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        expiresAt: true,
        iconEmoji: true,
        // Who shared it — prefer the owning human's name, fall back to the
        // creating agent's name. Email is only used via friendlyName() so the
        // raw address never reaches the page.
        ownerHuman: { select: { name: true, email: true } },
        agent: { select: { name: true } },
        templateVersion: {
          select: { template: { select: { name: true, slug: true } } },
        },
        // Distinct-viewer count from the HumanPaneView ledger.
        _count: { select: { views: true } },
      },
    }),
  ]);

  // Pane counts per template id — drives the "X panes →" chip on tiles
  // in My templates so the human can jump straight to their instances.
  const paneCountByTemplate = new Map<string, number>();
  for (const p of panesRaw) {
    const tid = p.templateVersion?.template?.id;
    if (tid) {
      paneCountByTemplate.set(tid, (paneCountByTemplate.get(tid) ?? 0) + 1);
    }
  }

  function toRef(t: {
    id: string;
    name: string;
    slug: string | null;
    publishedAt: Date | null;
    iconEmoji: string | null;
    iconAttachmentId: string | null;
    versions: Array<{ inputSchema: unknown }>;
    // Detail-page fields — only the public-catalog query selects these; other
    // callers (owned / installed) omit them and get the defaults below.
    description?: string | null;
    tags?: unknown;
    latestVersion?: number;
    installCount?: number;
  }): TemplateRef {
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      isAgentInit: hasRequiredInputSchema(t.versions[0]?.inputSchema),
      agentInitFields: requiredInputFields(t.versions[0]?.inputSchema),
      paneCount: paneCountByTemplate.get(t.id) ?? 0,
      isPublished: t.publishedAt !== null,
      iconEmoji: t.iconEmoji,
      hasIconImage: t.iconAttachmentId !== null,
      description: t.description ?? null,
      tags: Array.isArray(t.tags)
        ? t.tags.filter((x): x is string => typeof x === "string")
        : [],
      version: t.latestVersion ?? 0,
      installCount: t.installCount ?? 0,
    };
  }
  // Usage-maturity list gate — the "Yours" grid is the author's OWN authored
  // templates (ownerId ∈ the human's claimed agents), so it gets the same
  // ≥TEMPLATE_LIST_MIN_OPEN_PANES filter as GET /v1/templates. The `installs`
  // list below is the human's installed-from-store set (HumanTemplateInstall),
  // NOT authored work, so it is deliberately left unfiltered — a human keeps
  // every template they chose to install regardless of its open-pane count.
  const ownedTemplatesGated =
    config.TEMPLATE_LIST_MIN_OPEN_PANES > 0
      ? await filterByOpenPaneCount(
          prisma,
          ownedTemplatesRaw,
          config.TEMPLATE_LIST_MIN_OPEN_PANES,
        )
      : ownedTemplatesRaw;
  const ownedTemplates = ownedTemplatesGated.map(toRef);

  const liveInstalls = installs.filter((i) => i.template.deletedAt === null);
  const installedIds = new Set(liveInstalls.map((i) => i.template.id));
  const publicCatalog = publicCatalogRaw
    .filter((t) => !installedIds.has(t.id))
    .map(toRef);

  const favoritePaneIds = new Set(favoriteRows.map((r) => r.paneId));
  const panes: PaneRef[] = panesRaw.map((p) => {
    const tpl = p.templateVersion?.template ?? null;
    // Effective icon = pane override else template's. Resolve image + emoji
    // independently so a pane that overrides only the emoji still falls back
    // to the template's image (and vice versa).
    const hasIconImage =
      p.iconAttachmentId !== null || (tpl?.iconAttachmentId ?? null) !== null;
    const iconEmoji = p.iconEmoji ?? tpl?.iconEmoji ?? null;
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      accessMode: p.accessMode,
      tags: Array.isArray(p.tags)
        ? p.tags.filter((t): t is string => typeof t === "string")
        : [],
      templateId: tpl?.id ?? null,
      templateVersion: p.templateVersion?.version ?? 0,
      templateName: tpl?.name ?? tpl?.slug ?? null,
      isFavorite: favoritePaneIds.has(p.id),
      iconEmoji,
      hasIconImage,
    };
  });
  const favoritePanes = panes.filter((p) => p.isFavorite);

  const now = Date.now();
  const publicPanes: PublicPaneRef[] = publicPanesRaw.map((p) => {
    const ownerName = p.ownerHuman?.name?.trim();
    const sharedBy =
      (ownerName && ownerName.length > 0 ? ownerName : null) ??
      (p.ownerHuman?.email ? friendlyName(p.ownerHuman.email) : null) ??
      (p.agent?.name?.trim() || null) ??
      "someone";
    const tpl = p.templateVersion?.template ?? null;
    return {
      id: p.id,
      title: p.title,
      isLive: p.status === "open" && p.expiresAt.getTime() > now,
      createdAt: p.createdAt,
      sharedBy,
      viewerCount: p._count.views,
      iconEmoji: p.iconEmoji,
      templateName: tpl?.name ?? tpl?.slug ?? null,
    };
  });

  return {
    ownedTemplates,
    installs: liveInstalls.map((i) => ({
      template: toRef(i.template),
      installedVersion: i.installedVersion,
    })),
    publicCatalog,
    panes,
    favoritePanes,
    publicPanes,
    hasClaimedAgents: claimedAgents.length > 0,
    agents: claimedAgents.map((a) => ({
      id: a.id,
      name: a.name,
      keyPrefix: a.keyPrefix,
      claimedAt: a.claimedAt ? a.claimedAt.toISOString().slice(0, 10) : null,
      lastUsed: a.lastUsedAt ? relativeDate(a.lastUsedAt) : "never",
      revoked: a.revokedAt !== null,
    })),
  };
}

// ----- HTML rendering -----

function renderHtml(human: HumanRow, data: ShellData, nonce: string): string {
  const displayName =
    (human.name && human.name.trim()) || friendlyName(human.email);
  const avatarLetter = displayName.charAt(0).toUpperCase() || "?";

  // First-run nudge: a human with zero claimed agents has no way for panes
  // to appear here yet. Point them at /get-started. Hidden once they claim.
  const firstAgentNudge = data.hasClaimedAgents
    ? ""
    : `<a class="gs-nudge" href="/get-started">
          <span class="gs-nudge-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 4v4"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/></svg></span>
          <span class="gs-nudge-text"><b>Connect your first agent</b><span>Link your coding agent to start building panes you'll see here.</span></span>
          <span class="gs-nudge-cta">Set up an agent →</span>
        </a>`;

  const tplLibraryCount = data.ownedTemplates.length + data.installs.length;
  const panesCount = data.panes.length;
  const statsBits = [
    panesCount === 0
      ? "no open panes"
      : `${panesCount} ${panesCount === 1 ? "open pane" : "open panes"}`,
    `${tplLibraryCount} ${tplLibraryCount === 1 ? "template" : "templates"} in your library`,
  ];
  if (data.installs.length > 0) {
    statsBits.push(
      `${data.installs.length} install${data.installs.length === 1 ? "" : "s"}`,
    );
  }
  const stats = statsBits.join(" · ");

  // Home Favorites strip — pane-level. A pane is what the human actually
  // uses (and re-visits); the template is just where it came from.
  const favsHtml =
    data.favoritePanes.length === 0
      ? `<div class="empty-strip">No favorites yet. Tap the star on any pane to pin it here.</div>`
      : data.favoritePanes
          .slice(0, 12)
          .map((p) => favPaneTile(p))
          .join("");

  // Templates view grids.
  const minesHtml =
    data.ownedTemplates.length === 0
      ? `<div class="empty-strip" style="grid-column:1/-1;">No templates yet. Run <code>pane template create</code> from a claimed agent.</div>`
      : data.ownedTemplates
          .map((t) => appTile(t, { launchable: true, menu: "owned" }))
          .join("");
  const installedHtml =
    data.installs.length === 0
      ? `<div class="empty-strip" style="grid-column:1/-1;">No installs yet.</div>`
      : data.installs
          .map((i) =>
            appTile(i.template, { launchable: true, menu: "installed" }),
          )
          .join("");
  const discoverHtml =
    data.publicCatalog.length === 0
      ? `<div class="empty-strip" style="grid-column:1/-1;">Nothing in the public catalog yet. Once an agent runs <code>pane template publish</code>, they show up here.</div>`
      : data.publicCatalog
          .map((t) => appTile(t, { launchable: false, install: true }))
          .join("");

  // Per-template detail payload for the store detail modal (App-Store-style:
  // tapping a catalog tile opens this instead of installing on the spot). Keyed
  // by template id; only public-catalog templates carry the detail fields. The
  // `<` escape closes the one `</script>` breakout the HTML parser cares about.
  const catalogDetailJson = JSON.stringify(
    Object.fromEntries(
      data.publicCatalog.map((t) => [
        t.id,
        {
          name: t.name,
          description: t.description,
          tags: t.tags,
          version: t.version,
          installCount: t.installCount,
          isAgentInit: t.isAgentInit,
          iconEmoji: t.iconEmoji,
          hasIconImage: t.hasIconImage,
        },
      ]),
    ),
  ).replace(/</g, "\\u003c");

  // Panes list.
  const panesHtml =
    data.panes.length === 0
      ? `<li class="empty-strip">No live panes. Launch one from <a data-go="templates" style="color:var(--accent);cursor:pointer;">Templates</a>.</li>`
      : data.panes.map((p) => paneRow(p)).join("");

  // Tag vocabulary across the human's panes, for the Panes-tab chip filter.
  // Sorted by frequency (most-used first) then alphabetically so the common
  // tags lead the (scrollable) chip row.
  const tagFreq = new Map<string, number>();
  for (const p of data.panes)
    for (const t of p.tags) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
  const sortedTags = [...tagFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
  const hasFavorites = data.panes.some((p) => p.isFavorite);
  // chips: All + (★ Favorites if any) + each tag. data-chip carries the filter
  // key; the reserved "__fav__" maps to the per-human favorite state.
  const paneChipsHtml =
    sortedTags.length === 0 && !hasFavorites
      ? ""
      : `<div class="chip-row" id="panes-chips" role="group" aria-label="Filter panes by tag">
        <button class="chip on" type="button" data-chip="__all__">All</button>${
          hasFavorites
            ? `<button class="chip" type="button" data-chip="__fav__">★ Favorites</button>`
            : ""
        }${sortedTags
          .map(
            (t) =>
              `<button class="chip" type="button" data-chip="${escapeHtml(t)}">${escapeHtml(t)}</button>`,
          )
          .join("")}</div>`;

  // Explore list — public panes from the whole community.
  const publicPanesCount = data.publicPanes.length;
  const publicPanesHtml =
    publicPanesCount === 0
      ? `<li class="empty-strip">No public panes yet. Mark one of <a data-go="panes" style="color:var(--accent);cursor:pointer;">your panes</a> public to share it here.</li>`
      : data.publicPanes.map((p) => publicPaneRow(p)).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" content="#f7f5f1" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#14110d" media="(prefers-color-scheme: dark)" />
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" type="image/svg+xml" href="${BRAND_FAVICON_DATA_HREF}" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="pane" />
<title>pane</title>
<style nonce="${nonce}">${OWNER_SHELL_CSS}${EXTRA_CSS}</style>
</head>
<body>

<div class="app">
  <aside class="nav">
    <div class="brand">
      <div class="logo">${BRAND_LOGO}</div>
      <div class="name">Pane</div>
    </div>
    <ul class="items" id="nav-items">
      <li><button data-view="home" class="active">
        <span class="icon">${spaIco("home", 18)}</span>
        <span class="label">${NAV_LABELS.home}</span>
      </button></li>
      <li><button data-view="panes">
        <span class="icon">${spaIco("panes", 18)}</span>
        <span class="label">${NAV_LABELS.panes}</span>
        <span class="count">${panesCount}</span>
      </button></li>
      <li><button data-view="explore">
        <span class="icon">${spaIco("explore", 18)}</span>
        <span class="label">${NAV_LABELS.explore}</span>
        <span class="count">${publicPanesCount}</span>
      </button></li>
      <!-- Templates: your library + the public store, merged into one tab with
           a Yours/Store segmented control inside the view (was two tabs). The
           grid icon reads as "collection of templates"; the count is your
           library size. -->
      <li><button data-view="templates">
        <span class="icon">${spaIco("templates", 18)}</span>
        <span class="label">Templates</span>
        <span class="count">${tplLibraryCount}</span>
      </button></li>
    </ul>
    <div class="me" id="me">
      <div class="avatar">${escapeHtml(avatarLetter)}</div>
      <div class="who">
        <div class="name">${escapeHtml(displayName)}</div>
        <div class="sub">${escapeHtml(human.email)}</div>
      </div>
      <!-- Mobile-only trigger: a single "Account" tab in the bottom bar that
           toggles the .acct-links popover. Hidden on desktop, where the links
           render inline in the footer. -->
      <button class="acct-tab" id="acct-tab" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="acct-links" aria-label="${NAV_LABELS.account}">
        <span class="icon">${spaIco("account", 20)}</span>
        <span class="label">${NAV_LABELS.account}</span>
      </button>
      <!-- The action links. Inline icon row on desktop; popover sheet on mobile.
           Same DOM nodes both ways — a single #signout, no duplication. -->
      <div class="acct-links" id="acct-links" role="menu">
        <!-- Agents lives in the account menu (not a primary sidebar tab); it
             opens the in-SPA agents view via data-go (no full-page nav). -->
        <a class="acct-link" href="#agents" data-go="agents" role="menuitem" title="${NAV_LABELS.agents}" aria-label="${NAV_LABELS.agents}">
          <span class="ico">${spaIco("agents", 16)}</span>
          <span class="txt">${NAV_LABELS.agents}</span>
        </a>
        <a class="acct-link" href="#settings" data-go="settings" role="menuitem" title="${NAV_LABELS.settings}" aria-label="${NAV_LABELS.settings}">
          <span class="ico">${spaIco("settings", 16)}</span>
          <span class="txt">${NAV_LABELS.settings}</span>
        </a>
        <button class="acct-link" id="signout" type="button" role="menuitem" title="${NAV_LABELS.signout}" aria-label="${NAV_LABELS.signout}">
          <span class="ico">${spaIco("signout", 16)}</span>
          <span class="txt">${NAV_LABELS.signout}</span>
        </button>
      </div>
    </div>
  </aside>

  <main class="main">

    <section class="view active" data-view="home">
      <div class="greet">Hey, <span class="name">${escapeHtml(displayName)}</span> <span aria-hidden="true">👋</span></div>
      <div class="greet-sub">${escapeHtml(stats)}</div>
      ${firstAgentNudge}
      <div class="search" style="margin-top: 12px;">
        <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg></span>
        <input id="home-search" placeholder="Search favorites and recent panes…" autocomplete="off" />
      </div>

      <div class="section">
        <div class="section-head">
          <h2>Favorites</h2>
          <a data-go="mine">Edit</a>
        </div>
        <div class="favs" id="favs">${favsHtml}</div>
      </div>

      <!-- Recently viewed — panes this human has OPENED (any mount), sourced
           from the HumanPaneView ledger via GET /v1/self/recents. This is the
           Home-only pane strip: it can include panes the human doesn't own, so
           it's distinct from the Panes tab (owned/joined panes, with its own
           full list + filters). The redundant "Open panes" preview that just
           mirrored the top of the Panes tab was removed. Hidden until the fetch
           resolves with at least one row; stays out of the way when empty. -->
      <div class="section" id="recently-viewed-section" hidden>
        <div class="section-head">
          <h2>Recently viewed</h2>
        </div>
        <div class="recents" id="recently-viewed"></div>
      </div>

    </section>

    <section class="view" data-view="panes">
      <div class="view-head">
        <div>
          <h1>Panes</h1>
          <div class="sub">Live sessions you own or joined. Click to open.</div>
        </div>
      </div>
      <div class="search">
        <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg></span>
        <input id="panes-search" placeholder="Search your panes…" autocomplete="off" />
      </div>
      ${paneChipsHtml}
      <!-- Filter banner shown when the user arrives here from a template
           tile's "X panes →" chip. Hidden by default; populated + revealed
           by JS. -->
      <div id="pane-filter-banner" class="filter-banner" hidden>
        <span>Showing panes from <strong id="pane-filter-name"></strong></span>
        <button id="pane-filter-clear" type="button">Clear</button>
      </div>
      <ul class="panes-list" id="panes-list">${panesHtml}</ul>
    </section>

    <section class="view" data-view="explore">
      <div class="view-head">
        <div>
          <h1>Explore</h1>
          <div class="sub">Public panes shared by the community. Click one to open it live (read-only).</div>
        </div>
      </div>
      <div class="search">
        <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg></span>
        <input id="explore-search" placeholder="Search public panes…" autocomplete="off" />
      </div>
      <ul class="panes-list" id="explore-list">${publicPanesHtml}</ul>
    </section>

    <!-- Templates — your library and the public store under one view, switched
         by the Yours/Store segmented control. The two segments keep their own
         grids (and grid ids) so the launch/install/search logic is unchanged;
         only their containers are toggled. The Store segment is the former
         "Template store" view; the Yours segment is the former "My templates".
         data-default-seg lets the client open on Store when the library is
         empty (nothing of your own to show yet). -->
    <section class="view" data-view="templates" data-default-seg="${tplLibraryCount === 0 ? "store" : "yours"}">
      <div class="view-head">
        <div>
          <h1>Templates</h1>
          <div class="sub">Your library and the public store. Click a tile to launch.</div>
        </div>
      </div>
      <div class="seg" role="tablist" id="templates-seg" aria-label="Templates scope">
        <button class="seg-btn" type="button" data-seg="yours" role="tab" aria-selected="true">Yours <span class="count">${tplLibraryCount}</span></button>
        <button class="seg-btn" type="button" data-seg="store" role="tab" aria-selected="false">Store <span class="count">${data.publicCatalog.length}</span></button>
      </div>
      <div class="search">
        <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg></span>
        <input id="templates-search" placeholder="Search templates…" autocomplete="off" />
      </div>

      <div class="seg-panel" data-seg-panel="yours">
        <div class="cat-row"><h3>Yours</h3><span class="count">${data.ownedTemplates.length}</span></div>
        <div class="apps-grid" id="apps-mine">${minesHtml}</div>

        <div class="cat-row"><h3>Installed from store</h3><span class="count">${data.installs.length}</span></div>
        <div class="apps-grid" id="apps-installed">${installedHtml}</div>
      </div>

      <div class="seg-panel" data-seg-panel="store" hidden>
        <div class="cat-row"><h3>Discover</h3><span class="count">${data.publicCatalog.length}</span></div>
        <div class="apps-grid" id="apps-discover">${discoverHtml}</div>
      </div>
    </section>

    <section class="view" data-view="agents">
      <div class="view-head">
        <div>
          <h1>Agents</h1>
          <div class="sub">Agents bound to you via the claim flow. Claiming records ownership — each agent's API key still works after it.</div>
        </div>
      </div>
      <div class="agt-claim">
        <div class="agt-claim-row">
          <h3>Claim a new agent</h3>
          <button id="agt-gen-code" class="btn primary small" type="button">Generate claim code</button>
        </div>
        <p class="agt-hint">Generate a one-time code, then run <code>pane agent claim &lt;code&gt;</code> on the agent.</p>
        <div id="agt-code-out" class="agt-reveal" hidden>
          <div class="agt-reveal-label">Your code</div>
          <div class="agt-reveal-row">
            <code id="agt-code-value" class="agt-code"></code>
            <button id="agt-copy-code" type="button" class="btn small">Copy</button>
          </div>
          <div class="agt-reveal-foot">Expires in <span id="agt-code-ttl"></span>. Copy now — you won't see it again.</div>
        </div>
      </div>
      <div class="cat-row"><h3>Claimed</h3><span class="count">${data.agents.length}</span></div>
      ${
        data.agents.length === 0
          ? `<div class="empty-strip">No claimed agents yet. Generate a code above, then run <code>pane agent claim &lt;code&gt;</code> on the agent's machine.</div>`
          : `<ul class="agt-list">${data.agents.map(agentRowHtml).join("")}</ul>`
      }
    </section>

    <section class="view" data-view="settings">
      <div class="view-head">
        <div>
          <h1>Settings</h1>
          <div class="sub">Your account and session.</div>
        </div>
      </div>
      <div class="settings-card">
        <h2>Account</h2>
        <div class="settings-row" id="name-row">
          <span class="k">Name</span>
          <span class="name-field">
            <span class="v" id="name-value">${escapeHtml(displayName)}</span>
            <button id="name-edit" type="button" class="btn small" aria-label="Edit name"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>
            <span class="name-edit-form" id="name-edit-form" hidden>
              <input id="name-input" type="text" maxlength="80" autocomplete="name" />
              <button id="name-save" type="button" class="btn primary small">Save</button>
              <button id="name-cancel" type="button" class="btn small">Cancel</button>
            </span>
          </span>
        </div>
        <div class="settings-row"><span class="k">Status</span>${
          human.verifiedAt
            ? `<span class="pill good">Verified</span>`
            : `<span class="pill muted">Unverified</span>`
        }</div>
        <div class="settings-row"><span class="k">Account created</span><span class="v">${escapeHtml(
          human.createdAt.toISOString().slice(0, 10),
        )}</span></div>
      </div>
      <div class="settings-card">
        <h2>Session</h2>
        <p class="settings-note">Signing out revokes this device's login. You can sign back in any time at <a href="/login">/login</a>.</p>
        <button id="settings-signout" type="button" class="btn">Sign out of this device</button>
      </div>
    </section>

  </main>
</div>

<!-- Agent-init instructions modal. Hidden until a human taps an agent-init
     tile; populated client-side from the tile's slug + required-field data. -->
<div class="ai-modal" id="ai-modal" hidden>
  <div class="ai-modal-backdrop" data-ai-close></div>
  <div class="ai-modal-card" role="dialog" aria-modal="true" aria-labelledby="ai-modal-title">
    <button class="ai-modal-x" data-ai-close aria-label="Close">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="ai-modal-head">
      <span class="ai-modal-badge"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 4v4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg> agent-init</span>
      <h2 id="ai-modal-title"></h2>
    </div>
    <p class="ai-modal-lead">This template can't be opened directly — an agent must create a pane seeded with <code>input_data</code> first. Paste these instructions to your agent:</p>
    <div class="ai-modal-instr">
      <button class="ai-modal-copy" id="ai-modal-copy" type="button">Copy</button>
      <pre id="ai-modal-text"></pre>
    </div>
    <p class="ai-modal-foot">Already have a seeded pane? Open it from the <b>Panes</b> tab instead.</p>
  </div>
</div>

<!-- Store template detail — an App-Store-style sheet. A catalog tile opens this
     (instead of installing on the spot); the primary button installs + opens.
     Populated client-side from #catalog-detail; all text via textContent. -->
<div class="tpl-modal" id="tpl-detail-modal" hidden>
  <div class="tpl-backdrop" data-tpl-close></div>
  <div class="tpl-card" role="dialog" aria-modal="true" aria-labelledby="tpl-detail-name">
    <button class="tpl-x" data-tpl-close aria-label="Close">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="tpl-head">
      <div class="tpl-icon" id="tpl-detail-icon" aria-hidden="true"></div>
      <div class="tpl-head-text">
        <h2 id="tpl-detail-name"></h2>
        <div class="tpl-meta" id="tpl-detail-meta"></div>
      </div>
      <button class="btn primary" id="tpl-detail-action" type="button">Install &amp; Open</button>
    </div>
    <div class="tpl-err" id="tpl-detail-err" hidden></div>
    <div class="tpl-tags" id="tpl-detail-tags"></div>
    <div class="tpl-preview"><iframe id="tpl-detail-preview" sandbox="allow-scripts" loading="lazy" scrolling="no" tabindex="-1" aria-hidden="true"></iframe></div>
    <p class="tpl-desc" id="tpl-detail-desc"></p>
  </div>
</div>
<script type="application/json" id="catalog-detail">${catalogDetailJson}</script>

<script nonce="${nonce}">${SHELL_JS}</script>
</body>
</html>`;
}

// Derive the required input_data fields (name + JSON type) from a template
// version's input_schema, for the copy-paste agent instructions on an
// agent-init tile. Same notion of "required" as hasRequiredInputSchema; types
// fall back to "string" when a property declares none.
function requiredInputFields(
  schema: unknown,
): Array<{ name: string; type: string }> {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as {
    required?: unknown;
    properties?: Record<string, { type?: unknown }>;
  };
  if (!Array.isArray(s.required)) return [];
  const props = s.properties ?? {};
  return s.required
    .filter((n): n is string => typeof n === "string")
    .map((name) => {
      const t = props[name]?.type;
      return { name, type: typeof t === "string" ? t : "string" };
    });
}

// ----- Tile / row HTML helpers -----

// Shared inner markup for a square icon box. Render order: image → emoji →
// gradient monogram (the always-works fallback). The caller wraps this in the
// context-specific element (a `.icon` div, etc.) and supplies the class.
//
//   imageUrl — when set, an <img> filling the box (object-fit: cover). The
//              server only emits a URL when it knows an image icon exists, so
//              the <img> won't 404 in normal flow; we still add an onerror
//              hook that swaps in the monogram as belt-and-braces.
//   emoji    — a single emoji grapheme, rendered centered on a neutral
//              background when there's no image.
//   seedId   — stable seed for the monogram hue (pane/template id).
//   label    — text the monogram initials are derived from.
//   previewUrl — when set AND the icon resolves to the monogram fallback (no
//              image, no emoji), a lazy sandboxed <iframe> rendering a live
//              thumbnail of the artifact is layered ON TOP of the gradient
//              monogram. Only the BIG cards (favorites, app tiles, recents)
//              pass this; the 44px pane-row keeps the bare monogram. The
//              monogram stays as the tile background so transparent artifacts
//              still read against the page. Image / emoji icons are unchanged.
function iconTileInner(opts: {
  imageUrl?: string;
  emoji?: string | null;
  seedId: string;
  label: string;
  previewUrl?: string;
}): string {
  const hue = paneHue(opts.seedId);
  const initials = paneInitials(opts.label);
  const monogramStyle = `background:linear-gradient(135deg, hsl(${hue}, 80%, 70%) 0%, hsl(${(hue + 30) % 360}, 75%, 60%) 100%);`;

  if (opts.imageUrl) {
    // onerror falls back to the monogram if the image fails to load. The
    // handler is a static string (no interpolated user data) so it's CSP-safe
    // even under the shell's strict policy — but note the shell uses a
    // nonce'd inline-script CSP, so inline event handlers won't execute there.
    // The fallback is therefore best-effort cosmetic; the access-gated route
    // makes a 404 unlikely in the first place.
    return `<img class="tile-img" src="${escapeHtml(opts.imageUrl)}" alt="" loading="lazy" />`;
  }
  if (opts.emoji) {
    return `<span class="tile-emoji">${escapeHtml(opts.emoji)}</span>`;
  }
  const monogram = `<span class="tile-monogram" style="${monogramStyle}">${escapeHtml(initials)}</span>`;
  if (opts.previewUrl) {
    // Monogram first (the background layer), preview iframe on top. The iframe
    // is sandboxed (allow-scripts only — no forms/downloads for a thumbnail),
    // lazy-loaded, non-interactive (pointer-events:none in CSS keeps the card
    // clickable), and removed from the a11y/tab tree.
    return `${monogram}<iframe class="tile-preview" src="${escapeHtml(opts.previewUrl)}" sandbox="allow-scripts" loading="lazy" scrolling="no" tabindex="-1" aria-hidden="true"></iframe>`;
  }
  return monogram;
}

// Home Favorites strip — each tile is a pane (an instance), not a template.
// Clicking opens the pane directly.
function favPaneTile(p: PaneRef): string {
  const label = p.title || p.id;
  const inner = iconTileInner({
    imageUrl: p.hasIconImage
      ? `/panes/${encodeURIComponent(p.id)}/icon`
      : undefined,
    emoji: p.iconEmoji,
    seedId: p.id,
    label,
    previewUrl: `/panes/${encodeURIComponent(p.id)}/preview`,
  });
  return `<a class="fav-tile" href="/panes/${encodeURIComponent(p.id)}" data-pane-id="${escapeHtml(p.id)}">
    <div class="icon">${inner}</div>
    <div class="label">${escapeHtml(label)}</div>
  </a>`;
}

function appTile(
  t: TemplateRef,
  opts: {
    launchable: boolean;
    install?: boolean;
    /** `owned` shows Publish/Unpublish + Delete; `installed` shows
     *  Uninstall; omit on discover tiles (no menu). */
    menu?: "owned" | "installed";
  },
): string {
  // Human-visible label. Legacy inline templates have name+slug null; never
  // fall back to the raw cuid id here (it reads as random characters in the
  // UI). The id is still used for hue/data-* attributes via iconTileInner.
  const name = t.name ?? t.slug ?? "Untitled template";
  const inner = iconTileInner({
    imageUrl: t.hasIconImage
      ? `/templates/${encodeURIComponent(t.id)}/icon`
      : undefined,
    emoji: t.iconEmoji,
    seedId: t.id,
    label: name,
    previewUrl: `/templates/${encodeURIComponent(t.id)}/preview`,
  });
  const dataAttr = opts.install ? ` data-needs-install="1"` : "";
  // Agent-init tiles carry the slug + required-field descriptor so the click
  // handler can build copy-paste agent instructions client-side. Only emitted
  // for agent-init tiles to keep the rest lean.
  const agentInitData = t.isAgentInit
    ? ` data-template-slug="${escapeHtml(t.slug ?? t.id)}" data-agent-init-fields="${escapeHtml(JSON.stringify(t.agentInitFields))}"`
    : "";
  // Only agent-init templates carry a badge — they can't be launched cold by a
  // human (an agent must seed input_data first), and clicking one opens the
  // copy-paste agent instructions. A template with NO badge is ready to use:
  // "no tag = launchable" is the whole signal, so ready tiles stay unmarked.
  const badge = t.isAgentInit
    ? `<span class="tile-corner agent-init" title="Agent-init template — an agent must seed input_data before launch">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 4v4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>
        agent-init
      </span>`
    : "";
  // Triple-dots menu — Publish/Unpublish/Delete for owned, Uninstall for
  // installed. Discover tiles get no menu.
  const menuBtn = opts.menu
    ? `<button class="tile-menu-btn" data-template-menu="${escapeHtml(t.id)}" data-template-menu-kind="${opts.menu}" data-template-name="${escapeHtml(name)}" data-template-published="${t.isPublished ? "1" : "0"}" title="More" aria-label="More">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>
      </button>`
    : "";
  // "X panes →" chip — clickable footer that opens the Panes view filtered
  // to this template. Only shown when there's at least one live pane.
  const paneCountChip =
    t.paneCount > 0
      ? `<button class="pane-count-chip" data-template-filter="${escapeHtml(t.id)}" data-template-name="${escapeHtml(name)}" title="Show panes from this template">${t.paneCount} ${t.paneCount === 1 ? "pane" : "panes"} →</button>`
      : "";
  const wrapCls = t.isAgentInit ? "app-tile-wrap agent-init" : "app-tile-wrap";
  return `<div class="${wrapCls}" data-template-id="${escapeHtml(t.id)}">
    ${badge}${menuBtn}
    <button class="app-tile" data-template-id="${escapeHtml(t.id)}" data-template-name="${escapeHtml(name)}" data-launchable="${opts.launchable ? "1" : "0"}" data-agent-init="${t.isAgentInit ? "1" : "0"}"${agentInitData}${dataAttr}>
      <div class="icon">${inner}</div>
      <div class="label">${escapeHtml(name)}</div>
    </button>
    ${paneCountChip}
  </div>`;
}

// Visibility icon for a pane row — lock (invite-only), link (anyone with the
// link), or globe (public). Access mode persists per pane so every row gets
// one; we intentionally don't surface open/closed status here (closed panes
// are swept, so the list is effectively all-live).
function visibilityCell(accessMode: string): string {
  const ICONS: Record<string, { label: string; svg: string }> = {
    invite_only: {
      label: "Invite only",
      svg: `<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
    },
    link: {
      label: "Anyone with the link",
      svg: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
    },
    public: {
      label: "Public",
      svg: `<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>`,
    },
  };
  const v = ICONS[accessMode] ?? ICONS["link"]!;
  return `<div class="vis" title="${escapeHtml(v.label)}" aria-label="${escapeHtml(v.label)}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${v.svg}</svg>
    </div>`;
}

function agentRowHtml(a: AgentRow): string {
  const status = a.revoked
    ? `<span class="pill muted">Revoked</span>`
    : `<span class="pill good">Active</span>`;
  // Rotate + revoke are only meaningful on a live (non-revoked) agent — a
  // revoked key can't be rotated and revocation is permanent.
  const actions = a.revoked
    ? ""
    : `<button class="btn small" type="button" data-act="rotate" data-id="${escapeHtml(a.id)}" data-name="${escapeHtml(a.name)}">Regenerate key</button>
        <button class="btn small agt-danger" type="button" data-act="revoke" data-id="${escapeHtml(a.id)}" data-name="${escapeHtml(a.name)}">Revoke</button>`;
  return `<li class="agt-row" data-agent-id="${escapeHtml(a.id)}">
    <div class="agt-main">
      <div class="agt-name-row">
        <span class="agt-name" data-agent-name>${escapeHtml(a.name)}</span>
        <button class="agt-rename" type="button" data-act="rename" data-id="${escapeHtml(a.id)}" data-name="${escapeHtml(a.name)}" title="Rename" aria-label="Rename agent">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
      </div>
      <div class="agt-meta"><code>${escapeHtml(a.keyPrefix)}…</code> · claimed ${a.claimedAt ? escapeHtml(a.claimedAt) : "—"} · last used ${escapeHtml(a.lastUsed)}</div>
      <div class="agt-reveal agt-rotate-out" hidden>
        <div class="agt-reveal-label">New API key</div>
        <div class="agt-reveal-row">
          <code class="agt-code agt-rotate-value"></code>
          <button class="btn small agt-rotate-copy" type="button">Copy</button>
        </div>
        <div class="agt-reveal-foot">Won't be shown again. Run <code>pane agent set-key &lt;key&gt;</code> on the agent's machine (or set <code>PANE_API_KEY</code>).</div>
      </div>
    </div>
    <div class="agt-actions">${status}${actions}</div>
  </li>`;
}

function paneRow(p: PaneRef): string {
  // templateName is null for legacy inline templates; fall back to the pane's
  // own title (always present), never to the raw cuid id.
  const tplName = p.templateName ?? p.title ?? "Untitled template";
  const inner = iconTileInner({
    imageUrl: p.hasIconImage
      ? `/panes/${encodeURIComponent(p.id)}/icon`
      : undefined,
    emoji: p.iconEmoji,
    seedId: p.id,
    label: tplName,
  });
  const rel = relativeDate(p.createdAt);
  const tplAttr = p.templateId
    ? ` data-template-id="${escapeHtml(p.templateId)}"`
    : "";
  const starCls = p.isFavorite ? "row-star active" : "row-star";
  const starLabel = p.isFavorite ? "Unfavorite" : "Favorite";
  const starPath = p.isFavorite
    ? `<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01L12 2z" fill="currentColor"/>`
    : `<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01L12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`;
  // data-tags carries the row's tags as JSON so the chip filter can read them
  // exactly (tags are free-form, so no fragile delimiter). data-fav lets the
  // ★ Favorites chip filter without re-reading the star.
  const tagsHtml = p.tags.length
    ? `<div class="row-tags">${p.tags
        .map((t) => `<span class="row-tag">${escapeHtml(t)}</span>`)
        .join("")}</div>`
    : "";
  return `<li class="pane-row" data-pane-id="${escapeHtml(p.id)}" data-href="/panes/${encodeURIComponent(p.id)}"${tplAttr} data-fav="${p.isFavorite ? "1" : "0"}" data-tags="${escapeHtml(JSON.stringify(p.tags))}">
    <div class="icon">${inner}</div>
    <div class="info">
      <div class="title">${escapeHtml(p.title)}</div>
      <div class="meta">${escapeHtml(p.id)} · ${escapeHtml(tplName)} · ${escapeHtml(rel)}</div>
      ${tagsHtml}
    </div>
    ${visibilityCell(p.accessMode)}
    <button class="${starCls}" data-noopen="1" data-pane-fav-toggle="${escapeHtml(p.id)}" data-fav-on="${p.isFavorite ? "1" : "0"}" title="${escapeHtml(starLabel)}" aria-label="${escapeHtml(starLabel)}">
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">${starPath}</svg>
    </button>
    <button class="menu-btn" title="More" aria-label="More" data-noopen="1" data-pane-menu="${escapeHtml(p.id)}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>
    </button>
  </li>`;
}

// Explore-view row for a public pane. Reuses the .pane-row component but:
//  - opens /p/:id (the public read-only viewer) — works for ANY viewer,
//    unlike /panes/:id which 404s for non-owners;
//  - drops the favorite/share/menu controls (they mutate the viewer's own
//    library/sharing, meaningless for someone else's pane), so the grid is a
//    simpler icon + info + status (overridden inline);
//  - never links the owner-gated icon image — emoji or gradient monogram only.
function publicPaneRow(p: PublicPaneRef): string {
  const tplName = p.templateName ?? p.title ?? "Untitled template";
  const inner = iconTileInner({
    emoji: p.iconEmoji,
    seedId: p.id,
    label: tplName,
  });
  const rel = relativeDate(p.createdAt);
  const viewers = p.viewerCount === 1 ? "1 viewer" : `${p.viewerCount} viewers`;
  const meta = `by ${escapeHtml(p.sharedBy)} · ${escapeHtml(viewers)} · ${escapeHtml(rel)}`;
  const statusCls = p.isLive ? "live" : "closed";
  const statusText = p.isLive ? "live" : "ended";
  return `<li class="pane-row public" data-pane-id="${escapeHtml(p.id)}" data-href="/p/${encodeURIComponent(p.id)}" style="grid-template-columns:44px 1fr auto;">
    <div class="icon">${inner}</div>
    <div class="info">
      <div class="title">${escapeHtml(p.title)}</div>
      <div class="meta">${meta}</div>
    </div>
    <div class="status ${statusCls}">${escapeHtml(statusText)}</div>
  </li>`;
}

// ----- helpers -----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function friendlyName(email: string): string {
  const local = (email.split("@")[0] ?? "").split(/[._-]/)[0] ?? "";
  if (local.length === 0) return "there";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function paneHue(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

function paneInitials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  const words = trimmed
    .split(/[\s_\-/.]+/)
    .filter((w) => /[A-Za-z0-9]/.test(w));
  if (words.length === 0) return trimmed.slice(0, 2).toUpperCase();
  if (words.length === 1) return (words[0] ?? "").slice(0, 2).toUpperCase();
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
}

function relativeDate(when: Date): string {
  const now = new Date();
  const day = 86_400_000;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tgt = new Date(when.getFullYear(), when.getMonth(), when.getDate());
  const d = Math.round((start.getTime() - tgt.getTime()) / day);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 14) return `${d}d ago`;
  return when.toISOString().slice(0, 10);
}

// Extra CSS layered on top of the prototype's verbatim rules to fill
// shape gaps the prototype didn't have to handle (the prototype hard-
// coded mock data; the live page renders empty states + clickable rows).
const EXTRA_CSS = `
  .empty-strip { color: var(--ink-mute); font-size: 13px; padding: 12px 4px; }
  .pane-row { cursor: pointer; }
  .pane-row .menu-btn { cursor: pointer; }
  .pane-row:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
  .recent-card { text-decoration: none; color: inherit; }
  .app-tile, .fav-tile { font: inherit; }
  .fav-tile, .app-tile { background: transparent; border: none; }
  .btn.danger { color: var(--pink); border-color: rgba(251,113,133,0.3); }
  .btn.danger:hover { color: var(--pink); border-color: var(--pink); }

  /* Tile wrap holds the tile + the "X panes →" footer chip. */
  .app-tile-wrap { position: relative; display: flex; flex-direction: column; }
  .app-tile-wrap .pane-count-chip {
    margin-top: 4px; padding: 4px 8px; font-size: 11px;
    background: transparent; border: 1px solid var(--hairline);
    color: var(--ink-mute); border-radius: 4px; cursor: pointer;
    align-self: flex-start; transition: color 120ms, border-color 120ms;
    font: inherit; line-height: 1.2;
  }
  .app-tile-wrap .pane-count-chip:hover {
    color: var(--accent); border-color: rgba(147, 197, 253, 0.4);
  }

  /* Star toggle on each pane row — sits before the triple-dots menu.
     min 40×40 hit target: the bare 14px SVG would otherwise collapse to
     ~26×26, small enough on mobile that a slightly-off tap lands on the
     row and the row's click handler opens the pane. */
  .pane-row .row-star {
    background: transparent; border: none; color: var(--ink-mute);
    cursor: pointer; padding: 6px; border-radius: 6px;
    min-width: 40px; min-height: 40px;
    display: inline-flex; align-items: center; justify-content: center;
    transition: color 120ms, transform 120ms;
  }
  .pane-row .row-star:hover { color: var(--accent); transform: scale(1.08); }
  .pane-row .row-star.active { color: #fbbf24; }
  .pane-row .row-star.active:hover { color: #fbbf24; }

  /* Filter banner above the Panes list when filtered by a template. */
  .filter-banner {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 10px 14px; margin: 0 0 12px 0;
    background: rgba(147, 197, 253, 0.08);
    border: 1px solid rgba(147, 197, 253, 0.20);
    border-radius: 8px; color: var(--ink); font-size: 13px;
  }
  .filter-banner strong { color: var(--accent); font-weight: 600; }
  .filter-banner button {
    background: transparent; border: 1px solid var(--hairline);
    color: var(--ink-mute); padding: 4px 10px; border-radius: 4px;
    cursor: pointer; font: inherit; font-size: 12px;
  }
  .filter-banner button:hover { color: var(--ink); border-color: var(--hairline-2); }

  /* "agent-init" corner badge — top-left of agent-init template tiles only.
     Paired with an icon so the "needs an agent to initialize" type registers
     at a glance. Ready-to-use templates carry no badge. */
  .tile-corner {
    position: absolute; top: 6px; left: 6px; z-index: 2;
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 10.5px; font-weight: 600; line-height: 1;
    padding: 4px 7px; border-radius: 999px;
    letter-spacing: 0.02em;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    pointer-events: auto; user-select: none;
    backdrop-filter: blur(6px);
  }
  .tile-corner.agent-init {
    color: #e9deff;
    background: rgba(168, 85, 247, 0.30);
    border: 1px solid rgba(196, 181, 253, 0.55);
    box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.10) inset;
  }
  /* Light mode: the badge text was tuned light-on-translucent for the dark
     tile; on a white tile it needs dark text + a slightly stronger tint. */
  @media (prefers-color-scheme: light) {
    .tile-corner.agent-init {
      color: #6b21a8;
      background: rgba(168, 85, 247, 0.14);
      border-color: rgba(168, 85, 247, 0.40);
    }
  }

  /* Triple-dots menu trigger on owned + installed tiles. Top-right;
     mirrors the corner-badge position on the left. */
  .app-tile-wrap .tile-menu-btn {
    position: absolute; top: 6px; right: 6px; z-index: 2;
    width: 26px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--surface-2); border: 1px solid var(--hairline);
    color: var(--ink-mute); border-radius: 6px; cursor: pointer; padding: 0;
    backdrop-filter: blur(4px); transition: color 120ms, transform 120ms;
  }
  .app-tile-wrap .tile-menu-btn:hover { color: var(--ink); transform: scale(1.06); }

  /* Subtle outer accent on agent-init wraps so the type carries even without
     a visible badge (e.g. when scrolling fast / dense grid). Ready tiles get
     no accent — no badge, no outline: their plainness IS the signal. */
  .app-tile-wrap.agent-init .app-tile { box-shadow: inset 0 0 0 1px rgba(168, 85, 247, 0.18); }

  /* Lightweight floating popover for pane-row triple-dots menu. */
  .pane-menu-pop {
    position: fixed; z-index: 1000; min-width: 180px; padding: 4px;
    background: var(--bg-2); border: 1px solid var(--hairline);
    border-radius: 8px; box-shadow: var(--shadow-pop);
    display: flex; flex-direction: column;
  }
  .pane-menu-pop button {
    background: transparent; border: none; color: var(--ink, #e5e7eb);
    text-align: left; padding: 8px 10px; font: inherit; cursor: pointer;
    border-radius: 5px; font-size: 13px;
  }
  .pane-menu-pop button:hover { background: var(--surface-2); }
  .pane-menu-pop button.danger { color: var(--pink, #fb7185); }

  /* Editable display name (Settings → Account). The value, pencil, and the
     inline edit form share one inline-flex container so the row stays on a
     single line and the form sits where the value was. */
  .name-field { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .name-field .btn.small {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 4px 7px; line-height: 0;
  }
  .name-edit-form { display: inline-flex; align-items: center; gap: 6px; }
  #name-input {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: 5px 9px;
    color: var(--ink);
    font-size: 13px;
    font-family: inherit;
    min-width: 160px;
  }
  #name-input:focus { outline: none; border-color: var(--accent); }
  /* Share button on each pane row — sits between the star and the menu.
     Same 40×40 min hit target as .row-star for the same reason. */
  /* Store template detail — App-Store-style sheet. */
  .tpl-modal {
    position: fixed; inset: 0; z-index: 1300;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .tpl-backdrop { position: absolute; inset: 0; background: rgba(4, 6, 10, 0.66); backdrop-filter: blur(2px); }
  .tpl-card {
    position: relative; z-index: 1; width: 100%; max-width: 540px;
    max-height: calc(100vh - 40px); overflow-y: auto;
    background: var(--bg-2, #11151f); color: var(--ink);
    border: 1px solid var(--hairline); border-radius: 16px;
    box-shadow: var(--shadow-pop, 0 24px 64px rgba(0,0,0,0.5)); padding: 22px;
  }
  .tpl-x {
    position: absolute; top: 12px; right: 12px; width: 30px; height: 30px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: none; color: var(--ink-mute); cursor: pointer; border-radius: 8px;
  }
  .tpl-x:hover { color: var(--ink); background: var(--surface-2); }
  .tpl-head { display: flex; align-items: center; gap: 14px; margin-right: 28px; }
  .tpl-icon {
    flex: none; width: 60px; height: 60px; border-radius: 14px;
    display: flex; align-items: center; justify-content: center;
    font-size: 30px; background: var(--surface-2); overflow: hidden;
  }
  .tpl-icon img { width: 100%; height: 100%; object-fit: cover; }
  .tpl-head-text { flex: 1 1 auto; min-width: 0; }
  .tpl-head-text h2 { margin: 0 0 3px; font-size: 19px; overflow: hidden; text-overflow: ellipsis; }
  .tpl-meta { color: var(--ink-mute); font-size: 12.5px; font-family: var(--mono); }
  .tpl-head .btn.primary { flex: none; }
  .tpl-err {
    margin-top: 12px; padding: 8px 10px; border-radius: 8px;
    background: rgba(251,113,133,0.12); border: 1px solid rgba(251,113,133,0.35);
    color: var(--pink, #fb7185); font-size: 12.5px;
  }
  .tpl-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
  .tpl-tags .tpl-tag {
    font-size: 11px; color: var(--ink-mute);
    background: var(--surface-2); border: 1px solid var(--hairline);
    border-radius: 999px; padding: 2px 9px;
  }
  .tpl-preview {
    margin-top: 14px; height: 220px; border-radius: 12px; overflow: hidden;
    border: 1px solid var(--hairline); background: #fff;
  }
  .tpl-preview iframe { width: 100%; height: 100%; border: 0; display: block; }
  .tpl-desc {
    margin: 14px 0 0; color: var(--ink); font-size: 13.5px; line-height: 1.5;
    white-space: pre-wrap; word-wrap: break-word;
  }
  .tpl-desc:empty { display: none; }

  /* Agents view — claim card, claimed list, one-time-secret reveal boxes. */
  .agt-claim {
    background: var(--surface); border: 1px solid var(--hairline);
    border-radius: 12px; padding: 16px; margin-top: 4px;
  }
  .agt-claim-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .agt-claim-row h3 { margin: 0; font-size: 15px; }
  .agt-hint { color: var(--ink-mute); font-size: 13px; margin: 8px 0 0; }
  .agt-hint code, .agt-meta code, .agt-reveal-foot code { font-family: var(--mono); }
  .agt-reveal {
    margin-top: 12px; padding: 12px; border-radius: 10px;
    background: var(--surface-2); border: 1px solid var(--hairline);
  }
  .agt-reveal-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-mute); }
  .agt-reveal-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
  .agt-code { font-family: var(--mono); font-size: 13px; color: var(--ink); word-break: break-all; flex: 1 1 auto; }
  .agt-reveal-foot { font-size: 11.5px; color: var(--ink-mute); }
  .agt-list { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .agt-row {
    background: var(--surface); border: 1px solid var(--hairline); border-radius: 12px;
    padding: 12px 14px; display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap;
  }
  .agt-main { flex: 1 1 240px; min-width: 0; }
  .agt-name-row { display: flex; align-items: center; gap: 6px; }
  .agt-name { font-weight: 600; font-size: 14px; }
  .agt-rename {
    background: transparent; border: none; color: var(--ink-mute); cursor: pointer;
    padding: 3px; border-radius: 6px; line-height: 0;
  }
  .agt-rename:hover { color: var(--accent); }
  .agt-rename svg { display: block; }
  .agt-meta { color: var(--ink-mute); font-size: 12px; margin-top: 2px; }
  .agt-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .agt-danger { color: var(--pink, #fb7185); }
  .agt-danger:hover { border-color: var(--pink, #fb7185); }
  .agt-rename-form { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .agt-rename-form input {
    background: var(--surface-2); border: 1px solid var(--hairline); border-radius: 6px;
    padding: 4px 8px; color: var(--ink); font: inherit; font-size: 13px; min-width: 140px;
  }
  .agt-rename-form input:focus { outline: none; border-color: var(--accent); }

  /* Panes-tab tag filter — a scrollable chip row (one shared horizontal
     scrollbar) above the list, plus the small tag pills on each row. */
  .chip-row {
    display: flex; gap: 8px; flex-wrap: nowrap; overflow-x: auto;
    padding: 4px 2px 10px; margin: 0 -2px; scrollbar-width: thin;
  }
  .chip {
    flex: 0 0 auto; cursor: pointer;
    font-size: 12.5px; font-weight: 600; font-family: inherit;
    padding: 5px 12px; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--hairline);
    color: var(--ink-mute); transition: color 100ms, background 100ms, border-color 100ms;
  }
  .chip:hover { color: var(--ink); }
  .chip.on {
    background: var(--accent); color: #1a120c; border-color: transparent;
  }
  .pane-row .row-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
  .pane-row .row-tag {
    font-size: 10.5px; color: var(--ink-mute);
    background: var(--surface-2); border: 1px solid var(--hairline);
    border-radius: 999px; padding: 1px 8px;
  }
  /* Inline per-pane tag editor (row ⋯ → Edit tags). */
  .tag-editor { margin-top: 8px; }
  .tag-editor .te-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag-editor .te-chip {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; color: var(--ink);
    background: var(--surface-2); border: 1px solid var(--hairline);
    border-radius: 999px; padding: 2px 4px 2px 9px;
  }
  .tag-editor .te-x {
    background: transparent; border: none; color: var(--ink-mute);
    cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px; border-radius: 999px;
  }
  .tag-editor .te-x:hover { color: var(--pink, #fb7185); }
  .tag-editor .te-input {
    flex: 1 1 100px; min-width: 90px;
    background: var(--surface); border: 1px solid var(--hairline); border-radius: 8px;
    padding: 3px 8px; color: var(--ink); font: inherit; font-size: 12px;
  }
  .tag-editor .te-input:focus { outline: none; border-color: var(--accent); }
  .tag-editor .te-actions { display: flex; gap: 6px; margin-top: 8px; }

  /* Ensure [hidden] always wins — some flex rules above set display, which
     would otherwise re-show a hidden element. */
  [hidden] { display: none !important; }
`;

// ----- Client-side runtime -----
//
// Kept tiny — almost all the rendering happened server-side. The JS
// here:
//   1. Swaps the active view on nav click + URL hash change.
//   2. Routes deep-link tile/pane-row clicks (mostly via <a href> on
//      anchors; pane-row uses data-href + a JS click handler since
//      the row contains a non-link menu button).
//   3. Tile click → POST /v1/my-templates/:id/launch → redirect to the
//      new pane. Discover tiles (data-needs-install) install first, then
//      launch in the same click.
//   4. Search inputs filter visible tiles/rows live.
//   5. Sign-out → POST /v1/auth/logout → /login.

const SHELL_JS = `
(function () {
  const VIEWS = ['home', 'panes', 'explore', 'templates', 'agents', 'settings'];

  // The Templates view has two segments (Yours / Store). Each maps to its own
  // hash so deep links + browser back/forward land on the right scope, and so
  // the legacy "#store" / "#mine" links keep working: '#templates' / '#mine' /
  // '#apps' → Yours; '#store' → Store.
  function setSegment(seg) {
    const s = seg === 'store' ? 'store' : 'yours';
    document.querySelectorAll('#templates-seg .seg-btn').forEach((b) => {
      b.setAttribute('aria-selected', String(b.getAttribute('data-seg') === s));
    });
    document.querySelectorAll('[data-seg-panel]').forEach((p) => {
      p.hidden = p.getAttribute('data-seg-panel') !== s;
    });
    return s;
  }

  function activate(view, explicitSeg) {
    // Normalise legacy / aliased hashes onto the current view+segment model.
    // The Template store and My templates tabs merged into one Templates view;
    // '#store' opens it on the Store segment, '#mine' / '#apps' / the old
    // '#templates' on Yours. '#trash' was retired into Home. explicitSeg, when
    // given (the segment buttons), forces the scope regardless of the default.
    let seg = explicitSeg || null;
    if (view === 'store') { view = 'templates'; seg = seg || 'store'; }
    else if (view === 'mine' || view === 'apps' || view === 'templates') {
      view = 'templates';
      if (!seg) {
        // No explicit segment → honour the server's default (Store when the
        // library is empty, else Yours).
        const sec = document.querySelector('.view[data-view="templates"]');
        seg = (sec && sec.getAttribute('data-default-seg')) === 'store' ? 'store' : 'yours';
      }
    }
    if (view === 'trash') view = 'home';
    if (!VIEWS.includes(view)) view = 'home';

    document.querySelectorAll('.view').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-view') === view);
    });
    document.querySelectorAll('#nav-items button').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-view') === view);
    });

    // Resolve the hash: Templates reflects its segment ('#store' for Store,
    // '#templates' for Yours); every other view is just '#<view>'.
    let hash = view;
    if (view === 'templates') hash = setSegment(seg) === 'store' ? 'store' : 'templates';
    if ('#' + hash !== location.hash) {
      history.replaceState(null, '', '#' + hash);
    }
    // Scroll the active view back to the top so a re-activation feels fresh.
    document.querySelector('.main').scrollTop = 0;
  }
  function viewFromHash() {
    const h = (location.hash || '').replace(/^#/, '');
    // Pass aliases through to activate(), which normalises them.
    const known = VIEWS.concat(['store', 'mine', 'apps', 'trash']);
    return known.includes(h) ? h : 'home';
  }

  // Nav clicks
  document.querySelectorAll('#nav-items button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => activate(btn.getAttribute('data-view')));
  });
  // Segment switch within the Templates view — force the chosen scope.
  document.querySelectorAll('#templates-seg .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => activate('templates', btn.getAttribute('data-seg')));
  });
  // Cross-view links (e.g. "View all →" on Home)
  document.addEventListener('click', (ev) => {
    const a = ev.target instanceof HTMLElement && ev.target.closest('a[data-go]');
    if (a) {
      ev.preventDefault();
      activate(a.getAttribute('data-go'));
    }
  });
  window.addEventListener('hashchange', () => activate(viewFromHash()));

  // Sign out — both the popover item (#signout) and the in-view Settings
  // button (#settings-signout) revoke this device's login.
  async function signOut() {
    try { await fetch('/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    location.href = '/login';
  }
  document.getElementById('signout')?.addEventListener('click', signOut);
  document.getElementById('settings-signout')?.addEventListener('click', signOut);

  // Editable display name (Settings → Account). Opening the pen swaps the
  // value for an inline input and hides the Settings sign-out button — per
  // the UX requirement there's no sign-out while you're mid-edit. We hide
  // the button rather than the whole Session card so the explanatory note
  // stays put and the layout doesn't jump.
  (function () {
    const editBtn = document.getElementById('name-edit');
    const form = document.getElementById('name-edit-form');
    const valueEl = document.getElementById('name-value');
    const input = document.getElementById('name-input');
    const saveBtn = document.getElementById('name-save');
    const cancelBtn = document.getElementById('name-cancel');
    const signoutBtn = document.getElementById('settings-signout');
    if (!editBtn || !form || !valueEl || !input || !saveBtn || !cancelBtn) return;

    function open() {
      input.value = valueEl.textContent || '';
      valueEl.hidden = true;
      editBtn.hidden = true;
      form.hidden = false;
      if (signoutBtn) signoutBtn.hidden = true;
      input.focus();
      input.select();
    }
    function close() {
      form.hidden = true;
      valueEl.hidden = false;
      editBtn.hidden = false;
      if (signoutBtn) signoutBtn.hidden = false;
    }

    async function save() {
      const raw = input.value.trim();
      const name = raw.length === 0 ? null : raw;
      saveBtn.disabled = true;
      try {
        const res = await fetch('/v1/self/profile', {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          alert('Save failed: ' + ((body.error && body.error.message) || ('HTTP ' + res.status)));
          return; // keep the form open so the human can retry / fix
        }
        const body = await res.json().catch(() => ({}));
        const display = body.display_name || raw;
        valueEl.textContent = display;
        // Mirror the new name everywhere it's shown: sidebar, home greeting,
        // and the avatar initial.
        const sideName = document.querySelector('.me .who .name');
        if (sideName) sideName.textContent = display;
        const greetName = document.querySelector('.greet .name');
        if (greetName) greetName.textContent = display;
        const avatar = document.querySelector('.me .avatar');
        if (avatar) avatar.textContent = (display.charAt(0) || '?').toUpperCase();
        close();
      } catch (err) {
        alert('Save failed: network error');
      } finally {
        saveBtn.disabled = false;
      }
    }

    editBtn.addEventListener('click', open);
    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', save);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); save(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    });
  })();

  // Account menu (mobile) — the "Account" bottom-bar tab toggles the
  // .acct-links popover (My agents / Settings / Sign out). On desktop the
  // trigger is display:none and the links sit inline, so this is a no-op
  // there. Close on outside-click or Escape.
  (function () {
    const me = document.getElementById('me');
    const tab = document.getElementById('acct-tab');
    if (!me || !tab) return;
    const close = () => { me.classList.remove('open'); tab.setAttribute('aria-expanded', 'false'); };
    tab.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = me.classList.toggle('open');
      tab.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (ev) => {
      if (me.classList.contains('open') && ev.target instanceof Node && !me.contains(ev.target)) close();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
    // Tapping any popover item closes the sheet — including the in-app
    // Settings view-switch (data-go), which doesn't navigate away.
    me.querySelectorAll('.acct-link').forEach((l) => l.addEventListener('click', close));
  })();

  // Pane-row star toggle — POST/DELETE the pane favorite, swap the icon
  // in place, and add/remove the row from the Home favorites strip.
  document.body.addEventListener('click', async (ev) => {
    const star = ev.target instanceof HTMLElement && ev.target.closest('button[data-pane-fav-toggle]');
    if (!star) return;
    ev.preventDefault();
    ev.stopPropagation();
    const paneId = star.getAttribute('data-pane-fav-toggle');
    if (!paneId) return;
    const on = star.getAttribute('data-fav-on') === '1';
    const method = on ? 'DELETE' : 'POST';
    star.disabled = true;
    try {
      const res = await fetch('/v1/my-panes/' + encodeURIComponent(paneId) + '/favorite', {
        method, credentials: 'same-origin',
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        alert('Favorite failed: ' + ((body.error && body.error.message) || ('HTTP ' + res.status)));
        return;
      }
      const newOn = !on;
      star.setAttribute('data-fav-on', newOn ? '1' : '0');
      star.setAttribute('title', newOn ? 'Unfavorite' : 'Favorite');
      star.setAttribute('aria-label', newOn ? 'Unfavorite' : 'Favorite');
      star.classList.toggle('active', newOn);
      const svg = star.querySelector('svg');
      if (svg) {
        svg.innerHTML = newOn
          ? '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01L12 2z" fill="currentColor"/>'
          : '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01L12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>';
      }
      // Mirror the change in the Home Favorites strip without a reload.
      const favs = document.getElementById('favs');
      if (favs) {
        if (newOn) {
          const row = star.closest('.pane-row');
          const titleEl = row && row.querySelector('.title');
          const iconEl = row && row.querySelector('.icon');
          const title = titleEl ? (titleEl.textContent || paneId) : paneId;
          const iconStyle = iconEl ? iconEl.getAttribute('style') || '' : '';
          const iconText = iconEl ? (iconEl.textContent || '?') : '?';
          // Strip the placeholder "no favorites yet" message if it was here.
          const empty = favs.querySelector('.empty-strip');
          if (empty) empty.remove();
          const tile = document.createElement('a');
          tile.className = 'fav-tile';
          tile.href = '/panes/' + encodeURIComponent(paneId);
          tile.setAttribute('data-pane-id', paneId);
          tile.innerHTML =
            '<div class="icon" style="' + iconStyle.replace(/"/g, '&quot;') + '">' +
              iconText.replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) +
            '</div>' +
            '<div class="label"></div>';
          (tile.querySelector('.label')).textContent = title;
          favs.appendChild(tile);
        } else {
          const existing = favs.querySelector('[data-pane-id="' + CSS.escape(paneId) + '"]');
          if (existing) existing.remove();
          if (favs.children.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-strip';
            empty.textContent = 'No favorites yet. Tap the star on any pane to pin it here.';
            favs.appendChild(empty);
          }
        }
      }
    } catch (e) {
      alert('Network error — try again.');
    } finally {
      star.disabled = false;
    }
  });

  // Pane-count chip on a template tile — jump to Panes view filtered to
  // the clicked template. The handler runs BEFORE the tile-click listener
  // because the chip is matched first; we stopPropagation so the parent
  // tile doesn't try to launch a new pane.
  document.body.addEventListener('click', (ev) => {
    const chip = ev.target instanceof HTMLElement && ev.target.closest('button[data-template-filter]');
    if (!chip) return;
    ev.preventDefault();
    ev.stopPropagation();
    const tid = chip.getAttribute('data-template-filter');
    const tname = chip.getAttribute('data-template-name') || '';
    if (!tid) return;
    applyPaneFilter(tid, tname);
    activate('panes');
  });

  // Clear button on the filter banner.
  document.getElementById('pane-filter-clear')?.addEventListener('click', () => {
    applyPaneFilter(null, '');
  });

  function applyPaneFilter(templateId, templateName) {
    const banner = document.getElementById('pane-filter-banner');
    const nameEl = document.getElementById('pane-filter-name');
    const rows = document.querySelectorAll('#panes-list .pane-row');
    if (templateId) {
      if (banner) banner.hidden = false;
      if (nameEl) nameEl.textContent = templateName || 'this template';
      rows.forEach((row) => {
        const match = row.getAttribute('data-template-id') === templateId;
        row.style.display = match ? '' : 'none';
      });
    } else {
      if (banner) banner.hidden = true;
      if (nameEl) nameEl.textContent = '';
      rows.forEach((row) => { row.style.display = ''; });
    }
  }

  // Agent-init instructions modal. A human can't cold-launch an agent-init
  // template (it needs input_data only an agent can seed), so instead of
  // launching we show copy-paste instructions to hand to an agent. Built
  // client-side from the tile's slug + required-field descriptor.
  (function () {
    const modal = document.getElementById('ai-modal');
    const titleEl = document.getElementById('ai-modal-title');
    const textEl = document.getElementById('ai-modal-text');
    const copyBtn = document.getElementById('ai-modal-copy');
    if (!modal || !titleEl || !textEl || !copyBtn) return;

    function placeholderFor(type) {
      switch (type) {
        case 'integer': case 'number': return 0;
        case 'boolean': return false;
        case 'array': return [];
        case 'object': return {};
        default: return '';
      }
    }
    function buildInstructions(name, slug, fields) {
      const skeleton = {};
      for (const f of fields) skeleton[f.name] = placeholderFor(f.type);
      const json = JSON.stringify(skeleton);
      const fieldList = fields.length
        ? fields.map((f) => f.name + ' (' + f.type + ')').join(', ')
        : '(see the template input_schema)';
      return (
        'Create a Pane from the "' + name + '" template (slug: ' + slug + '), ' +
        'seed its input_data, and send me the human URL.\\n\\n' +
        'Required input_data fields: ' + fieldList + '\\n\\n' +
        'pane create --template-id ' + slug +
        " --ttl 86400 --input-data '" + json + "'"
      );
    }
    function close() { modal.hidden = true; }

    window.showAgentInitModal = function (tile) {
      const name = tile.getAttribute('data-template-name') || 'This template';
      const slug = tile.getAttribute('data-template-slug') || tile.getAttribute('data-template-id') || '';
      let fields = [];
      try { fields = JSON.parse(tile.getAttribute('data-agent-init-fields') || '[]'); } catch (e) { fields = []; }
      titleEl.textContent = name + ' needs agent initialization';
      textEl.textContent = buildInstructions(name, slug, fields);
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
      modal.hidden = false;
    };

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textEl.textContent || '');
        copyBtn.textContent = 'Copied';
        copyBtn.classList.add('copied');
      } catch (e) {
        // Clipboard blocked (insecure context / permissions) — select the
        // text so the human can copy manually.
        const r = document.createRange();
        r.selectNodeContents(textEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        copyBtn.textContent = 'Select+copy';
      }
    });
    modal.querySelectorAll('[data-ai-close]').forEach((el) =>
      el.addEventListener('click', close),
    );
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !modal.hidden) close();
    });
  })();

  // Tile click → launch. Discover tiles (data-needs-install) auto-install
  // first and then launch in the same click — no detour through the old
  // /my-templates page.
  document.body.addEventListener('click', async (ev) => {
    // Sub-controls inside the tile have their own handlers (pane-count chip,
    // tile-menu trigger). Bail so we don't double-fire.
    if (ev.target instanceof HTMLElement && ev.target.closest('button[data-template-filter]')) return;
    if (ev.target instanceof HTMLElement && ev.target.closest('button[data-template-menu]')) return;
    const tile = ev.target instanceof HTMLElement &&
      (ev.target.closest('.fav-tile') || ev.target.closest('.app-tile'));
    if (!tile) return;
    // Home favorites strip — favPaneTile is an <a> with its own navigation;
    // let the browser handle it instead of going through the launch path.
    if (tile.tagName === 'A') return;
    const id = tile.getAttribute('data-template-id');
    if (!id) return;
    // Agent-init templates can't be cold-launched from a tile: their
    // input_schema has required fields only an agent can seed (via POST
    // /v1/panes input_data). Launching would mint a pane with no input_data
    // and strand the human in the template's empty state. The launch route
    // refuses this too (defense-in-depth); intercept here and show copy-paste
    // instructions the human can hand to an agent instead.
    if (tile.getAttribute('data-agent-init') === '1') {
      window.showAgentInitModal(tile);
      return;
    }
    const needsInstall = tile.getAttribute('data-needs-install') === '1';
    // Store (catalog) tile → open the App-Store-style detail sheet instead of
    // installing on the spot. The sheet's primary button runs install + open.
    // Owned/installed tiles (needsInstall === false) keep launching directly.
    if (needsInstall && window.openTemplateDetail) {
      window.openTemplateDetail(id);
      return;
    }
    const labelEl = tile.querySelector('.label');
    const origLabel = labelEl ? labelEl.textContent : '';
    function reset() {
      if (labelEl) labelEl.textContent = origLabel;
      tile.disabled = false;
    }
    tile.disabled = true;
    try {
      if (labelEl) labelEl.textContent = 'Launching…';
      const res = await fetch('/v1/my-templates/' + encodeURIComponent(id) + '/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        reset();
        const body = await res.json().catch(() => ({}));
        alert('Launch failed: ' + ((body.error && body.error.message) || ('HTTP ' + res.status)));
        return;
      }
      const body = await res.json();
      const url = body.urls && body.urls.humans && body.urls.humans[0];
      if (url) location.href = url;
    } catch (e) {
      reset();
      alert('Network error — try again.');
    }
  });

  // Pane-row click → open the pane. Skip when the menu button is the target.
  document.body.addEventListener('click', (ev) => {
    const row = ev.target instanceof HTMLElement && ev.target.closest('.pane-row');
    if (!row) return;
    if (ev.target instanceof HTMLElement && ev.target.closest('[data-noopen="1"]')) return;
    const href = row.getAttribute('data-href');
    if (href) location.href = href;
  });

  // Pane-row triple-dots menu — Open / Copy URL / Delete. Floats next to the
  // clicked button; closes on outside click or Escape. Delete hits the new
  // cookie-authed DELETE /v1/my-panes/:id endpoint.
  let openMenu = null;
  function closeMenu() {
    if (openMenu) { openMenu.remove(); openMenu = null; }
  }

  // Inline per-pane tag editor (owner edits) — opened from the row ⋯ menu.
  // Removable chips + an add input; Save PATCHes /v1/my-panes/:id/tags and
  // re-renders the row's pills + data-tags so the chip filter sees the change.
  function openTagEditor(row) {
    if (!row || row.querySelector('.tag-editor')) return;
    const info = row.querySelector('.info');
    if (!info) return;
    const paneId = row.getAttribute('data-pane-id');
    let tags;
    try { tags = JSON.parse(row.getAttribute('data-tags') || '[]'); }
    catch (e) { tags = []; }
    tags = Array.isArray(tags) ? tags.slice() : [];
    const existing = row.querySelector('.row-tags');
    if (existing) existing.style.display = 'none';

    const editor = document.createElement('div');
    editor.className = 'tag-editor';
    editor.setAttribute('data-noopen', '1');
    const chipWrap = document.createElement('div');
    chipWrap.className = 'te-chips';
    function makeChip(t) {
      const c = document.createElement('span');
      c.className = 'te-chip';
      const label = document.createElement('span');
      label.textContent = t;
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'te-x'; x.textContent = '×';
      x.setAttribute('aria-label', 'Remove ' + t);
      x.addEventListener('click', () => { tags = tags.filter((v) => v !== t); c.remove(); });
      c.appendChild(label); c.appendChild(x);
      return c;
    }
    tags.forEach((t) => chipWrap.appendChild(makeChip(t)));
    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = 'Add tag…'; input.maxLength = 50;
    input.className = 'te-input';
    function addPending() {
      const t = input.value.trim();
      if (t && tags.indexOf(t) === -1) { tags.push(t); chipWrap.insertBefore(makeChip(t), input); }
      input.value = '';
    }
    input.addEventListener('keydown', (k) => {
      if (k.key === 'Enter') { k.preventDefault(); addPending(); }
      else if (k.key === 'Escape') { done(); }
    });
    chipWrap.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'te-actions';
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'btn primary small'; save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn small'; cancel.textContent = 'Cancel';
    actions.appendChild(save); actions.appendChild(cancel);
    editor.appendChild(chipWrap); editor.appendChild(actions);
    info.appendChild(editor);
    input.focus();

    function done() { editor.remove(); if (existing) existing.style.display = ''; }
    cancel.addEventListener('click', done);
    save.addEventListener('click', async () => {
      addPending();
      save.disabled = true; save.textContent = 'Saving…';
      try {
        const res = await fetch('/v1/my-panes/' + encodeURIComponent(paneId) + '/tags', {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tags: tags }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          alert('Save failed: ' + ((b.error && b.error.message) || ('HTTP ' + res.status)));
          save.disabled = false; save.textContent = 'Save'; return;
        }
        const body = await res.json();
        const next = Array.isArray(body.tags) ? body.tags : [];
        row.setAttribute('data-tags', JSON.stringify(next));
        let rt = row.querySelector('.row-tags');
        if (!rt) { rt = document.createElement('div'); rt.className = 'row-tags'; info.appendChild(rt); }
        rt.textContent = '';
        next.forEach((t) => { const s = document.createElement('span'); s.className = 'row-tag'; s.textContent = t; rt.appendChild(s); });
        rt.style.display = next.length ? '' : 'none';
        done();
      } catch (e) { alert('Network error — try again.'); save.disabled = false; save.textContent = 'Save'; }
    });
  }

  document.addEventListener('click', (ev) => {
    if (openMenu && ev.target instanceof Node && !openMenu.contains(ev.target)) closeMenu();
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenu(); });
  document.body.addEventListener('click', (ev) => {
    const btn = ev.target instanceof HTMLElement && ev.target.closest('button[data-pane-menu]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const paneId = btn.getAttribute('data-pane-menu');
    if (!paneId) return;
    closeMenu();
    const pop = document.createElement('div');
    pop.className = 'pane-menu-pop';
    pop.innerHTML =
      '<button data-act="open">Open</button>' +
      '<button data-act="copy">Copy URL</button>' +
      '<button data-act="tags">Edit tags</button>' +
      '<button data-act="delete" class="danger">Delete</button>';
    document.body.appendChild(pop);
    // Position the pop-up below the trigger, flipping above if it'd run
    // off the bottom of the viewport.
    const rect = btn.getBoundingClientRect();
    pop.style.top = rect.bottom + 4 + 'px';
    pop.style.left = Math.max(8, rect.right - pop.offsetWidth) + 'px';
    if (rect.bottom + pop.offsetHeight > window.innerHeight - 8) {
      pop.style.top = (rect.top - pop.offsetHeight - 4) + 'px';
    }
    openMenu = pop;

    pop.addEventListener('click', async (mev) => {
      const target = mev.target instanceof HTMLElement && mev.target.closest('button[data-act]');
      if (!target) return;
      mev.stopPropagation();
      const act = target.getAttribute('data-act');
      const url = location.origin + '/panes/' + encodeURIComponent(paneId);
      if (act === 'open') {
        location.href = '/panes/' + encodeURIComponent(paneId);
      } else if (act === 'tags') {
        closeMenu();
        const row = document.querySelector('.pane-row[data-pane-id="' + (window.CSS && CSS.escape ? CSS.escape(paneId) : paneId) + '"]');
        if (row) openTagEditor(row);
      } else if (act === 'copy') {
        try {
          await navigator.clipboard.writeText(url);
          target.textContent = 'Copied!';
          setTimeout(closeMenu, 600);
        } catch {
          prompt('Copy this URL:', url);
          closeMenu();
        }
      } else if (act === 'delete') {
        if (!confirm('Move this pane to trash?')) return;
        target.disabled = true;
        try {
          const res = await fetch('/v1/my-panes/' + encodeURIComponent(paneId), {
            method: 'DELETE', credentials: 'same-origin',
          });
          if (!res.ok && res.status !== 204) {
            const body = await res.json().catch(() => ({}));
            alert('Delete failed: ' + ((body.error && body.error.message) || ('HTTP ' + res.status)));
            target.disabled = false;
            return;
          }
          closeMenu();
          // Soft-remove the row so the list reflects reality without a
          // full reload — and refresh the panes count chip in the nav.
          const row = document.querySelector('.pane-row[data-pane-id="' + CSS.escape(paneId) + '"]');
          if (row) row.remove();
          const navCount = document.querySelector('#nav-items button[data-view="panes"] .count');
          if (navCount) {
            const n = parseInt(navCount.textContent || '0', 10);
            if (!isNaN(n) && n > 0) navCount.textContent = String(n - 1);
          }
        } catch {
          alert('Network error — try again.');
          target.disabled = false;
        }
      }
    });
  });

  // Template-tile triple-dots menu — Publish/Unpublish/Delete on owned
  // tiles, Uninstall on installed tiles. Reuses the .pane-menu-pop style.
  document.body.addEventListener('click', (ev) => {
    const btn = ev.target instanceof HTMLElement && ev.target.closest('button[data-template-menu]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const tid = btn.getAttribute('data-template-menu');
    const kind = btn.getAttribute('data-template-menu-kind');
    const name = btn.getAttribute('data-template-name') || '';
    const published = btn.getAttribute('data-template-published') === '1';
    if (!tid || !kind) return;
    closeMenu();
    const pop = document.createElement('div');
    pop.className = 'pane-menu-pop';
    let html = '';
    if (kind === 'owned') {
      html += published
        ? '<button data-act="unpublish">Unpublish</button>'
        : '<button data-act="publish">Publish to store</button>';
      html += '<button data-act="delete" class="danger">Delete template</button>';
    } else if (kind === 'installed') {
      html += '<button data-act="uninstall" class="danger">Uninstall</button>';
    }
    pop.innerHTML = html;
    document.body.appendChild(pop);
    const rect = btn.getBoundingClientRect();
    pop.style.top = rect.bottom + 4 + 'px';
    pop.style.left = Math.max(8, rect.right - pop.offsetWidth) + 'px';
    if (rect.bottom + pop.offsetHeight > window.innerHeight - 8) {
      pop.style.top = (rect.top - pop.offsetHeight - 4) + 'px';
    }
    openMenu = pop;

    pop.addEventListener('click', async (mev) => {
      const target = mev.target instanceof HTMLElement && mev.target.closest('button[data-act]');
      if (!target) return;
      mev.stopPropagation();
      const act = target.getAttribute('data-act');

      async function callAction(path, method, okStatuses) {
        target.disabled = true;
        try {
          const res = await fetch(path, { method, credentials: 'same-origin' });
          if (!okStatuses.includes(res.status)) {
            const body = await res.json().catch(() => ({}));
            alert('Failed: ' + ((body.error && body.error.message) || ('HTTP ' + res.status)));
            target.disabled = false;
            return false;
          }
          return true;
        } catch {
          alert('Network error — try again.');
          target.disabled = false;
          return false;
        }
      }

      if (act === 'publish') {
        if (!confirm('Publish "' + name + '" to the public Template store? Anyone will be able to install it.')) return;
        const ok = await callAction('/v1/my-templates/' + encodeURIComponent(tid) + '/publish', 'POST', [200, 201]);
        if (ok) { closeMenu(); location.reload(); }
      } else if (act === 'unpublish') {
        if (!confirm('Unpublish "' + name + '" from the store? Existing installs keep working.')) return;
        const ok = await callAction('/v1/my-templates/' + encodeURIComponent(tid) + '/unpublish', 'POST', [200]);
        if (ok) { closeMenu(); location.reload(); }
      } else if (act === 'delete') {
        if (!confirm('Delete "' + name + '"? Existing panes derived from it keep working until they expire.')) return;
        const ok = await callAction('/v1/my-templates/' + encodeURIComponent(tid), 'DELETE', [204]);
        if (ok) {
          closeMenu();
          // Remove every tile referencing this template from the DOM,
          // and decrement the My templates count chip.
          document.querySelectorAll('.app-tile-wrap[data-template-id="' + CSS.escape(tid) + '"]').forEach((el) => el.remove());
          const navCount = document.querySelector('#nav-items button[data-view="templates"] .count');
          if (navCount) {
            const n = parseInt(navCount.textContent || '0', 10);
            if (!isNaN(n) && n > 0) navCount.textContent = String(n - 1);
          }
        }
      } else if (act === 'uninstall') {
        if (!confirm('Uninstall "' + name + '"? You can install it again later from the Template store.')) return;
        const ok = await callAction('/v1/templates/' + encodeURIComponent(tid) + '/uninstall', 'POST', [200, 204]);
        if (ok) { closeMenu(); location.reload(); }
      }
    });
  });

  // Search boxes filter visible tiles by label text.
  function bindSearch(inputId, selectors) {
    const input = document.getElementById(inputId);
    if (!input) return;
    function apply() {
      const q = input.value.trim().toLowerCase();
      selectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          const hay = (el.textContent || '').toLowerCase();
          el.style.display = (q.length === 0 || hay.includes(q)) ? '' : 'none';
        });
      });
    }
    input.addEventListener('input', apply);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { input.value = ''; apply(); } });
  }
  bindSearch('home-search', ['#favs .fav-tile', '#recently-viewed .recent-card']);
  // One search for the merged Templates view. It filters all three grids; only
  // the active segment's panel is visible, so filtering the hidden one is a
  // harmless no-op and the box keeps working across a segment switch.
  bindSearch('templates-search', ['#apps-mine .app-tile-wrap', '#apps-installed .app-tile-wrap', '#apps-discover .app-tile-wrap']);
  bindSearch('explore-search', ['#explore-list .pane-row']);
  // Panes tab — combined search + tag-chip filter. A row shows iff it matches
  // the search text AND every selected chip (AND semantics). "All" clears the
  // chip selection; "__fav__" is the reserved Favorites pseudo-tag.
  (function () {
    const list = document.getElementById('panes-list');
    const search = document.getElementById('panes-search');
    const chips = document.getElementById('panes-chips');
    if (!list) return;
    const selected = new Set();
    function rowTags(row) {
      try { return JSON.parse(row.getAttribute('data-tags') || '[]'); }
      catch (e) { return []; }
    }
    function apply() {
      const q = (search && search.value.trim().toLowerCase()) || '';
      list.querySelectorAll('.pane-row').forEach((row) => {
        let show = q.length === 0 || (row.textContent || '').toLowerCase().includes(q);
        if (show && selected.size) {
          const tags = rowTags(row);
          const fav = row.getAttribute('data-fav') === '1';
          for (const sel of selected) {
            if (sel === '__fav__') { if (!fav) { show = false; break; } }
            else if (tags.indexOf(sel) === -1) { show = false; break; }
          }
        }
        row.style.display = show ? '' : 'none';
      });
    }
    if (search) {
      search.addEventListener('input', apply);
      search.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { search.value = ''; apply(); } });
    }
    if (chips) {
      chips.addEventListener('click', (ev) => {
        const btn = ev.target instanceof HTMLElement && ev.target.closest('button[data-chip]');
        if (!btn) return;
        const key = btn.getAttribute('data-chip');
        if (key === '__all__') selected.clear();
        else if (selected.has(key)) selected.delete(key);
        else selected.add(key);
        chips.querySelectorAll('button[data-chip]').forEach((b) => {
          const k = b.getAttribute('data-chip');
          b.classList.toggle('on', k === '__all__' ? selected.size === 0 : selected.has(k));
        });
        apply();
      });
    }
  })();

  // Recently viewed — fetch the human's HumanPaneView ledger and render a
  // distinct Home section. Graceful when empty (the section stays hidden) and
  // on error (logs, leaves the section hidden — never blocks the page).
  (function () {
    const section = document.getElementById('recently-viewed-section');
    const list = document.getElementById('recently-viewed');
    if (!section || !list) return;
    function hue(seed) {
      let h = 5381;
      for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
      return Math.abs(h) % 360;
    }
    function initials(name) {
      const t = (name || '').trim();
      if (!t) return '?';
      const w = t.split(/[\\s_\\-/.]+/).filter((x) => /[A-Za-z0-9]/.test(x));
      if (!w.length) return t.slice(0, 2).toUpperCase();
      if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
      return (w[0][0] + w[1][0]).toUpperCase();
    }
    // Visibility icon (lock / link / globe) for a card's access mode — mirrors
    // the server-rendered visibilityCell() used on the Panes tab.
    function visInner(mode) {
      if (mode === 'public') return '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>';
      if (mode === 'invite_only') return '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
      return '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>';
    }
    function visLabel(mode) {
      return mode === 'public' ? 'Public'
        : mode === 'invite_only' ? 'Invite only'
        : 'Anyone with the link';
    }

    // A small ⋯ menu per card — Open + Copy URL, plus Delete when the human
    // owns the pane. Recents can include panes the human only joined, so the
    // Delete button is gated on the owned flag from /v1/self/recents (the
    // server also re-checks ownership on DELETE /v1/my-panes/:id). Reuses the
    // .pane-menu-pop styling; the pop lives on document.body so the thumb's
    // overflow:hidden can't clip it.
    let recentMenu = null;
    function closeRecentMenu() { if (recentMenu) { recentMenu.remove(); recentMenu = null; } }
    function openRecentMenu(btn, paneId, owned) {
      closeRecentMenu();
      const url = location.origin + '/panes/' + encodeURIComponent(paneId);
      const pop = document.createElement('div');
      pop.className = 'pane-menu-pop';
      pop.innerHTML = '<button data-act="open">Open</button><button data-act="copy">Copy URL</button>'
        + (owned ? '<button data-act="delete" class="danger">Delete</button>' : '');
      document.body.appendChild(pop);
      const rect = btn.getBoundingClientRect();
      pop.style.top = (rect.bottom + 4) + 'px';
      pop.style.left = Math.max(8, rect.right - pop.offsetWidth) + 'px';
      if (rect.bottom + pop.offsetHeight > window.innerHeight - 8) {
        pop.style.top = (rect.top - pop.offsetHeight - 4) + 'px';
      }
      recentMenu = pop;
      pop.addEventListener('click', async (mev) => {
        const t = mev.target instanceof HTMLElement && mev.target.closest('button[data-act]');
        if (!t) return;
        mev.stopPropagation();
        const act = t.getAttribute('data-act');
        if (act === 'open') {
          location.href = '/panes/' + encodeURIComponent(paneId);
        } else if (act === 'copy') {
          try {
            await navigator.clipboard.writeText(url);
            t.textContent = 'Copied!';
            setTimeout(closeRecentMenu, 600);
          } catch {
            prompt('Copy this URL:', url);
            closeRecentMenu();
          }
        } else if (act === 'delete') {
          if (!confirm('Move this pane to trash?')) return;
          t.disabled = true;
          try {
            const res = await fetch('/v1/my-panes/' + encodeURIComponent(paneId), {
              method: 'DELETE', credentials: 'same-origin',
            });
            if (!res.ok && res.status !== 204) {
              const body = await res.json().catch(() => ({}));
              alert('Delete failed: ' + ((body.error && body.error.message) || ('HTTP ' + res.status)));
              t.disabled = false;
              return;
            }
            closeRecentMenu();
            // Drop the card so Recents reflects the trashed pane without a reload.
            const card = list.querySelector('.recent-card[data-pane-id="' + (window.CSS && CSS.escape ? CSS.escape(paneId) : paneId) + '"]');
            if (card) card.remove();
            if (!list.querySelector('.recent-card')) section.hidden = true;
          } catch {
            alert('Network error — try again.');
            t.disabled = false;
          }
        }
      });
    }
    document.addEventListener('click', (ev) => {
      if (recentMenu && ev.target instanceof Node && !recentMenu.contains(ev.target)) closeRecentMenu();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeRecentMenu(); });

    // Card click → open the pane, unless a no-open control (the ⋯ menu) was hit.
    function navTo(ev) {
      if (ev.target instanceof HTMLElement && ev.target.closest('[data-noopen]')) return;
      const c = ev.target instanceof HTMLElement && ev.target.closest('.recent-card[data-href]');
      if (c) location.href = c.getAttribute('data-href');
    }
    list.addEventListener('click', navTo);
    list.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') navTo(ev); });

    fetch('/v1/self/recents', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const items = body && Array.isArray(body.items) ? body.items : [];
        if (!items.length) return;
        for (const it of items.slice(0, 12)) {
          const title = it.title || it.pane_id;
          const h = hue(it.pane_id);
          const card = document.createElement('div');
          card.className = 'recent-card';
          card.setAttribute('data-href', '/panes/' + encodeURIComponent(it.pane_id));
          card.setAttribute('data-pane-id', it.pane_id);
          card.setAttribute('role', 'link');
          card.setAttribute('tabindex', '0');
          const thumb = document.createElement('div');
          thumb.className = 'thumb';
          thumb.style.background =
            'linear-gradient(135deg, hsl(' + h + ', 80%, 70%) 0%, hsl(' + ((h + 30) % 360) + ', 75%, 60%) 100%)';
          const glyph = document.createElement('span');
          glyph.className = 'glyph';
          glyph.textContent = initials(title);
          thumb.appendChild(glyph);
          // Layer a lazy preview iframe on top of the gradient glyph — same
          // shape as the server-rendered pane tiles elsewhere on Home.
          // Without this, closed/old panes in the ledger only show the
          // gradient + initials and never the real HTML.
          const previewFrame = document.createElement('iframe');
          previewFrame.className = 'tile-preview';
          previewFrame.src = '/panes/' + encodeURIComponent(it.pane_id) + '/preview';
          previewFrame.setAttribute('sandbox', 'allow-scripts');
          previewFrame.setAttribute('loading', 'lazy');
          previewFrame.setAttribute('scrolling', 'no');
          previewFrame.setAttribute('tabindex', '-1');
          previewFrame.setAttribute('aria-hidden', 'true');
          thumb.appendChild(previewFrame);
          // Visibility badge (top-left) + ⋯ menu (top-right) overlaid on the thumb.
          const vis = document.createElement('span');
          vis.className = 'recent-vis';
          vis.title = visLabel(it.access_mode);
          vis.setAttribute('aria-label', vis.title);
          vis.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + visInner(it.access_mode) + '</svg>';
          thumb.appendChild(vis);
          const menuBtn = document.createElement('button');
          menuBtn.className = 'recent-menu-btn';
          menuBtn.type = 'button';
          menuBtn.setAttribute('data-noopen', '1');
          menuBtn.title = 'More';
          menuBtn.setAttribute('aria-label', 'More');
          menuBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>';
          menuBtn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); openRecentMenu(menuBtn, it.pane_id, !!it.owned); });
          thumb.appendChild(menuBtn);
          const titleEl = document.createElement('div');
          titleEl.className = 'title';
          titleEl.textContent = title;
          card.appendChild(thumb);
          card.appendChild(titleEl);
          list.appendChild(card);
        }
        section.hidden = false;
      })
      .catch(() => { /* leave hidden — recents are non-essential */ });
  })();

  // Store template detail sheet — opened from a catalog tile via
  // window.openTemplateDetail(id). Renders from the #catalog-detail JSON; the
  // primary button installs the template then opens a fresh pane.
  (function () {
    const modal = document.getElementById('tpl-detail-modal');
    if (!modal) return;
    const iconEl = document.getElementById('tpl-detail-icon');
    const nameEl = document.getElementById('tpl-detail-name');
    const metaEl = document.getElementById('tpl-detail-meta');
    const tagsEl = document.getElementById('tpl-detail-tags');
    const descEl = document.getElementById('tpl-detail-desc');
    const previewEl = document.getElementById('tpl-detail-preview');
    const actionBtn = document.getElementById('tpl-detail-action');
    const errEl = document.getElementById('tpl-detail-err');
    if (!iconEl || !nameEl || !metaEl || !tagsEl || !descEl || !previewEl || !actionBtn) return;
    let catalog = {};
    try {
      const el = document.getElementById('catalog-detail');
      catalog = el ? JSON.parse(el.textContent || '{}') : {};
    } catch (e) { catalog = {}; }
    let currentId = null;
    let lastFocus = null;

    function showErr(m) { if (errEl) { errEl.textContent = m; errEl.hidden = false; } }
    function clearErr() { if (errEl) { errEl.hidden = true; errEl.textContent = ''; } }
    function initials(name) {
      const t = (name || '').trim();
      if (!t) return '?';
      const w = t.split(/[\\s_\\-/.]+/).filter((x) => /[A-Za-z0-9]/.test(x));
      if (!w.length) return t.slice(0, 2).toUpperCase();
      if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
      return (w[0][0] + w[1][0]).toUpperCase();
    }

    async function installAndOpen(id) {
      clearErr();
      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = 'Installing…';
      try {
        const ins = await fetch('/v1/templates/' + encodeURIComponent(id) + '/install', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          credentials: 'same-origin', body: '{}',
        });
        if (!ins.ok) {
          const b = await ins.json().catch(() => ({}));
          showErr('Install failed: ' + ((b.error && b.error.message) || ('HTTP ' + ins.status)));
          actionBtn.disabled = false; actionBtn.textContent = orig; return;
        }
        actionBtn.textContent = 'Opening…';
        const res = await fetch('/v1/my-templates/' + encodeURIComponent(id) + '/launch', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          showErr('Open failed: ' + ((b.error && b.error.message) || ('HTTP ' + res.status)));
          actionBtn.disabled = false; actionBtn.textContent = orig; return;
        }
        const b = await res.json();
        const url = b.urls && b.urls.humans && b.urls.humans[0];
        if (url) location.href = url;
      } catch (e) {
        showErr('Network error — try again.');
        actionBtn.disabled = false; actionBtn.textContent = orig;
      }
    }

    function open(id) {
      const d = catalog[id];
      if (!d) { installAndOpen(id); return; }
      currentId = id;
      clearErr();
      nameEl.textContent = d.name || id;
      const n = d.installCount || 0;
      metaEl.textContent = 'v' + (d.version || 1) + ' · ' + (n === 1 ? '1 install' : n + ' installs');
      iconEl.textContent = '';
      if (d.hasIconImage) {
        const img = document.createElement('img');
        img.src = '/templates/' + encodeURIComponent(id) + '/icon';
        img.alt = '';
        iconEl.appendChild(img);
      } else {
        iconEl.textContent = d.iconEmoji || initials(d.name || id);
      }
      tagsEl.textContent = '';
      (Array.isArray(d.tags) ? d.tags : []).slice(0, 8).forEach((tag) => {
        const s = document.createElement('span');
        s.className = 'tpl-tag';
        s.textContent = tag;
        tagsEl.appendChild(s);
      });
      descEl.textContent = d.description || '';
      previewEl.src = '/templates/' + encodeURIComponent(id) + '/preview';
      // Agent-init templates can't be cold-launched by a human — disable the
      // action and explain, mirroring the tile behaviour.
      actionBtn.textContent = d.isAgentInit ? 'Agent-init only' : 'Install & Open';
      actionBtn.disabled = !!d.isAgentInit;
      if (d.isAgentInit) {
        showErr('This template needs an agent to seed its inputs before it runs — it can\\'t be opened directly from here.');
      }
      lastFocus = document.activeElement;
      modal.hidden = false;
    }

    function close() {
      modal.hidden = true;
      previewEl.src = 'about:blank';
      currentId = null;
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    }

    actionBtn.addEventListener('click', () => { if (currentId) installAndOpen(currentId); });
    modal.querySelectorAll('[data-tpl-close]').forEach((el) => el.addEventListener('click', close));
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !modal.hidden) close(); });

    window.openTemplateDetail = open;
  })();

  // Agents view — claim a new agent (one-time code), rotate / revoke a key
  // (one-time-secret disclosure for the new key), and rename inline. Ported
  // from the old standalone /my-agents page so it shares the SPA chrome.
  (function () {
    const view = document.querySelector('.view[data-view="agents"]');
    if (!view) return;

    async function copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text); return true;
        }
      } catch (e) { /* fall through */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta); return ok;
      } catch (e) { return false; }
    }
    function flashCopy(btn, ok) {
      const orig = btn.textContent;
      btn.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
    async function errText(res) {
      try { const b = await res.json(); if (b && b.error && b.error.message) return b.error.message; } catch (e) { /* */ }
      return 'HTTP ' + res.status;
    }

    // Generate claim code.
    const genBtn = document.getElementById('agt-gen-code');
    if (genBtn) {
      genBtn.addEventListener('click', async () => {
        genBtn.disabled = true;
        const orig = genBtn.textContent;
        genBtn.textContent = 'Generating…';
        try {
          const res = await fetch('/v1/self/claim-codes', { method: 'POST', credentials: 'same-origin' });
          if (!res.ok) { alert('Failed to generate code: ' + (await errText(res))); return; }
          const b = await res.json();
          const val = document.getElementById('agt-code-value');
          const ttl = document.getElementById('agt-code-ttl');
          if (val) val.textContent = b.code;
          if (ttl) ttl.textContent = Math.max(0, Math.round((new Date(b.expires_at).getTime() - Date.now()) / 60000)) + ' min';
          const out = document.getElementById('agt-code-out');
          if (out) out.hidden = false;
        } catch (e) { alert('Network error — try again.'); }
        finally { genBtn.disabled = false; genBtn.textContent = orig; }
      });
    }
    const copyCodeBtn = document.getElementById('agt-copy-code');
    if (copyCodeBtn) {
      copyCodeBtn.addEventListener('click', async () => {
        const val = document.getElementById('agt-code-value');
        const code = (val && val.textContent) || '';
        if (code) flashCopy(copyCodeBtn, await copyText(code));
      });
    }

    // Row actions (rename / rotate / revoke / copy new key) — delegated.
    view.addEventListener('click', async (ev) => {
      const t = ev.target instanceof HTMLElement ? ev.target : null;
      if (!t) return;
      const btn = t.closest('button[data-act], button.agt-rotate-copy');
      if (!btn) return;
      const row = btn.closest('.agt-row[data-agent-id]');
      if (!row) return;
      const id = row.getAttribute('data-agent-id');

      if (btn.classList.contains('agt-rotate-copy')) {
        const v = row.querySelector('.agt-rotate-value');
        const code = (v && v.textContent) || '';
        if (code) flashCopy(btn, await copyText(code));
        return;
      }
      const act = btn.getAttribute('data-act');
      const name = btn.getAttribute('data-name') || 'this agent';

      if (act === 'rename') {
        const nameEl = row.querySelector('[data-agent-name]');
        if (!nameEl || row.querySelector('.agt-rename-form')) return;
        const current = nameEl.textContent || '';
        const form = document.createElement('span');
        form.className = 'agt-rename-form';
        const input = document.createElement('input');
        input.type = 'text'; input.maxLength = 80; input.value = current;
        const save = document.createElement('button');
        save.type = 'button'; save.className = 'btn primary small'; save.textContent = 'Save';
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'btn small'; cancel.textContent = 'Cancel';
        form.appendChild(input); form.appendChild(save); form.appendChild(cancel);
        nameEl.hidden = true; btn.hidden = true;
        nameEl.parentNode.insertBefore(form, nameEl.nextSibling);
        input.focus(); input.select();
        function done() { form.remove(); nameEl.hidden = false; btn.hidden = false; }
        cancel.addEventListener('click', done);
        input.addEventListener('keydown', (k) => { if (k.key === 'Escape') done(); if (k.key === 'Enter') save.click(); });
        save.addEventListener('click', async () => {
          const next = input.value.trim();
          if (!next || next === current) { done(); return; }
          save.disabled = true; save.textContent = 'Saving…';
          try {
            const res = await fetch('/v1/self/agents/' + encodeURIComponent(id), {
              method: 'PATCH', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: next }),
            });
            if (!res.ok) { alert('Rename failed: ' + (await errText(res))); save.disabled = false; save.textContent = 'Save'; return; }
            const b = await res.json();
            nameEl.textContent = b.name;
            // Keep the action buttons' data-name in sync for confirm prompts.
            row.querySelectorAll('[data-name]').forEach((el) => el.setAttribute('data-name', b.name));
            done();
          } catch (e) { alert('Network error — try again.'); save.disabled = false; save.textContent = 'Save'; }
        });
        return;
      }

      if (act === 'rotate') {
        if (!confirm('Regenerate the API key for ' + name + '?\\n\\nThe current key stops working immediately. You will see the new key once.')) return;
        btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Regenerating…';
        try {
          const res = await fetch('/v1/self/agents/' + encodeURIComponent(id) + '/rotate-key', { method: 'POST', credentials: 'same-origin' });
          if (!res.ok) { alert("Couldn't regenerate key: " + (await errText(res))); btn.disabled = false; btn.textContent = orig; return; }
          const b = await res.json();
          const reveal = row.querySelector('.agt-rotate-out');
          const valEl = row.querySelector('.agt-rotate-value');
          if (valEl) valEl.textContent = b.api_key;
          if (reveal) reveal.hidden = false;
          btn.remove();
        } catch (e) { alert('Network error — try again.'); btn.disabled = false; btn.textContent = orig; }
        return;
      }

      if (act === 'revoke') {
        if (!confirm('Revoke the API key for ' + name + '?\\n\\nThe key stops working immediately and revocation is permanent. Claim a fresh agent if you need this one again.')) return;
        btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Revoking…';
        try {
          const res = await fetch('/v1/self/agents/' + encodeURIComponent(id) + '/revoke-key', { method: 'POST', credentials: 'same-origin' });
          if (!res.ok) { alert("Couldn't revoke key: " + (await errText(res))); btn.disabled = false; btn.textContent = orig; return; }
          const pill = row.querySelector('.pill');
          if (pill) { pill.className = 'pill muted'; pill.textContent = 'Revoked'; }
          const rotate = row.querySelector("button[data-act='rotate']");
          if (rotate) rotate.remove();
          btn.remove();
        } catch (e) { alert('Network error — try again.'); btn.disabled = false; btn.textContent = orig; }
        return;
      }
    });
  })();

  // Initial view selection from the URL hash.
  activate(viewFromHash());
})();
`;
