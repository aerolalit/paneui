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
import { BRAND_FAVICON_DATA_HREF } from "../../brand.js";
import { NAV_GLYPHS, NAV_LABELS, type NavKey } from "./nav-meta.js";

// Wrap a shared nav glyph (nav-meta.ts) in the SPA's <svg> conventions so the
// sidebar / account / mobile-bar icons stay byte-identical to the legacy
// system-pages tab icons — one source of truth, no drift. `size` is px.
function spaIco(key: NavKey, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_GLYPHS[key]}</svg>`;
}

// ----- Public entry: serve the SPA -----

export interface OwnerShellOptions {
  prisma: PrismaClient;
  human: HumanRow;
}

export async function renderOwnerShell(
  opts: OwnerShellOptions,
): Promise<string> {
  const data = await loadShellData(opts.prisma, opts.human);
  return renderHtml(opts.human, data);
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
}

interface PaneRef {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  templateId: string | null;
  templateVersion: number;
  templateName: string | null;
  /** True when this pane is starred by the human. Drives the Home
   *  Favorites strip and the star toggle on each pane row. */
  isFavorite: boolean;
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
}

async function loadShellData(
  prisma: PrismaClient,
  human: HumanRow,
): Promise<ShellData> {
  // One human owns N claimed agents; their templates are the "Yours"
  // section under My templates.
  const claimedAgents = await prisma.agent.findMany({
    where: { ownerHumanId: human.id, deletedAt: null },
    select: { id: true },
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
  ] = await Promise.all([
    claimedAgentIds.length === 0
      ? Promise.resolve([])
      : prisma.template.findMany({
          where: {
            ownerId: { in: claimedAgentIds },
            deletedAt: null,
            name: { not: null },
          },
          orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
          select: {
            id: true,
            name: true,
            slug: true,
            publishedAt: true,
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
        templateVersion: {
          select: {
            version: true,
            template: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    }),
    prisma.humanPaneFavorite.findMany({
      where: { humanId: human.id, pane: { deletedAt: null } },
      orderBy: { addedAt: "desc" },
      select: { paneId: true },
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
    name: string | null;
    slug: string | null;
    publishedAt: Date | null;
    versions: Array<{ inputSchema: unknown }>;
  }): TemplateRef {
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      isAgentInit: hasRequiredInputs(t.versions[0]?.inputSchema),
      paneCount: paneCountByTemplate.get(t.id) ?? 0,
      isPublished: t.publishedAt !== null,
    };
  }
  const ownedTemplates = ownedTemplatesRaw.map(toRef);

  const liveInstalls = installs.filter((i) => i.template.deletedAt === null);
  const installedIds = new Set(liveInstalls.map((i) => i.template.id));
  const publicCatalog = publicCatalogRaw
    .filter((t) => !installedIds.has(t.id))
    .map(toRef);

  const favoritePaneIds = new Set(favoriteRows.map((r) => r.paneId));
  const panes: PaneRef[] = panesRaw.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    templateId: p.templateVersion?.template?.id ?? null,
    templateVersion: p.templateVersion?.version ?? 0,
    templateName:
      p.templateVersion?.template?.name ??
      p.templateVersion?.template?.slug ??
      null,
    isFavorite: favoritePaneIds.has(p.id),
  }));
  const favoritePanes = panes.filter((p) => p.isFavorite);

  return {
    ownedTemplates,
    installs: liveInstalls.map((i) => ({
      template: toRef(i.template),
      installedVersion: i.installedVersion,
    })),
    publicCatalog,
    panes,
    favoritePanes,
  };
}

// ----- HTML rendering -----

function renderHtml(human: HumanRow, data: ShellData): string {
  const displayName =
    (human.name && human.name.trim()) || friendlyName(human.email);
  const avatarLetter = displayName.charAt(0).toUpperCase() || "?";

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

  // Recents strip from panes.
  const recentsHtml =
    data.panes.length === 0
      ? `<div class="empty-strip">No open panes. Launch one from the Templates view.</div>`
      : data.panes
          .slice(0, 8)
          .map((p) => recentCard(p))
          .join("");

  // Home "All templates" grid — owned + installed deduped (by id).
  // Compose a set of "owned" ids so the home grid can tag the matching
  // tile as owned (it appears in both lists; the owned tile wins).
  const ownedIds = new Set(data.ownedTemplates.map((t) => t.id));
  const homeAllTemplates = dedupTemplates([
    ...data.ownedTemplates,
    ...data.installs.map((i) => i.template),
  ]);
  const homeAppsHtml =
    homeAllTemplates.length === 0
      ? `<div class="empty-strip" style="grid-column:1/-1;">Your library is empty. Install one from the catalog or run <code>pane template create</code>.</div>`
      : homeAllTemplates
          .map((t) =>
            appTile(t, {
              launchable: true,
              menu: ownedIds.has(t.id) ? "owned" : "installed",
            }),
          )
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

  // Panes list.
  const panesHtml =
    data.panes.length === 0
      ? `<li class="empty-strip">No live panes. Launch one from <a data-go="mine" style="color:var(--brand-1);cursor:pointer;">My templates</a> or the <a data-go="store" style="color:var(--brand-1);cursor:pointer;">Template store</a>.</li>`
      : data.panes.map((p) => paneRow(p)).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#0a0d14" />
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="icon" type="image/svg+xml" href="${BRAND_FAVICON_DATA_HREF}" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="pane" />
<title>pane</title>
<style>${OWNER_SHELL_CSS}${EXTRA_CSS}</style>
</head>
<body>

<div class="app">
  <aside class="nav">
    <div class="brand">
      <div class="logo">P</div>
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
      <li><button data-view="store">
        <span class="icon">${spaIco("store", 18)}</span>
        <span class="label">${NAV_LABELS.store}</span>
        <span class="count">${data.publicCatalog.length}</span>
      </button></li>
      <li><button data-view="mine">
        <span class="icon">${spaIco("templates", 18)}</span>
        <span class="label">${NAV_LABELS.templates}</span>
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
        <a class="acct-link" href="/my-agents" role="menuitem" title="${NAV_LABELS.agents}" aria-label="${NAV_LABELS.agents}">
          <span class="ico">${spaIco("agents", 16)}</span>
          <span class="txt">${NAV_LABELS.agents}</span>
        </a>
        <a class="acct-link" href="/settings" role="menuitem" title="${NAV_LABELS.settings}" aria-label="${NAV_LABELS.settings}">
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
      <div class="search" style="margin-top: 12px;">
        <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg></span>
        <input id="home-search" placeholder="Search templates, panes, anything…" autocomplete="off" />
      </div>

      <div class="section">
        <div class="section-head">
          <h2>Favorites</h2>
          <a data-go="mine">Edit</a>
        </div>
        <div class="favs" id="favs">${favsHtml}</div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2>Open panes</h2>
          <a data-go="panes">View all →</a>
        </div>
        <div class="recents" id="recents">${recentsHtml}</div>
      </div>

      <div class="section">
        <div class="section-head">
          <h2>All templates</h2>
          <a data-go="store">Browse Template store →</a>
        </div>
        <div class="apps-grid" id="home-apps">${homeAppsHtml}</div>
      </div>
    </section>

    <section class="view" data-view="panes">
      <div class="view-head">
        <div>
          <h1>Panes</h1>
          <div class="sub">Live sessions you own or joined. Click to open.</div>
        </div>
      </div>
      <!-- Filter banner shown when the user arrives here from a template
           tile's "X panes →" chip. Hidden by default; populated + revealed
           by JS. -->
      <div id="pane-filter-banner" class="filter-banner" hidden>
        <span>Showing panes from <strong id="pane-filter-name"></strong></span>
        <button id="pane-filter-clear" type="button">Clear</button>
      </div>
      <ul class="panes-list" id="panes-list">${panesHtml}</ul>
    </section>

    <section class="view" data-view="store">
      <div class="view-head">
        <div>
          <h1>Template store</h1>
          <div class="sub">Public templates anyone can install. Click a tile to add it to your library and launch.</div>
        </div>
      </div>
      <div class="search">
        <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg></span>
        <input id="store-search" placeholder="Search the Template store…" autocomplete="off" />
      </div>

      <div class="cat-row"><h3>Discover</h3><span class="count">${data.publicCatalog.length}</span></div>
      <div class="apps-grid" id="apps-discover">${discoverHtml}</div>
    </section>

    <section class="view" data-view="mine">
      <div class="view-head">
        <div>
          <h1>My templates</h1>
          <div class="sub">Templates you own or have installed. Click to launch.</div>
        </div>
      </div>
      <div class="search">
        <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg></span>
        <input id="mine-search" placeholder="Search your templates…" autocomplete="off" />
      </div>

      <div class="cat-row"><h3>Yours</h3><span class="count">${data.ownedTemplates.length}</span></div>
      <div class="apps-grid" id="apps-mine">${minesHtml}</div>

      <div class="cat-row"><h3>Installed from store</h3><span class="count">${data.installs.length}</span></div>
      <div class="apps-grid" id="apps-installed">${installedHtml}</div>
    </section>

  </main>
</div>

<script>${SHELL_JS}</script>
</body>
</html>`;
}

// ----- Tile / row HTML helpers -----

// Home Favorites strip — each tile is a pane (an instance), not a template.
// Clicking opens the pane directly.
function favPaneTile(p: PaneRef): string {
  const label = p.title || p.id;
  const hue = paneHue(p.id);
  const initials = paneInitials(label);
  return `<a class="fav-tile" href="/panes/${encodeURIComponent(p.id)}" data-pane-id="${escapeHtml(p.id)}">
    <div class="icon" style="background:linear-gradient(135deg, hsl(${hue}, 80%, 70%) 0%, hsl(${(hue + 30) % 360}, 75%, 60%) 100%);">${escapeHtml(initials)}</div>
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
  const name = t.name ?? t.slug ?? t.id;
  const hue = paneHue(t.id);
  const initials = paneInitials(name);
  const dataAttr = opts.install ? ` data-needs-install="1"` : "";
  // The badge sits at the top-right of the tile, with a clear icon
  // alongside the word so the type registers at a glance. Earlier versions
  // tucked a 10px text pill at the bottom — too easy to miss.
  const badge = t.isAgentInit
    ? `<span class="tile-corner agent-init" title="Agent-init template — an agent must seed input_data before launch">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 4v4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>
        agent-init
      </span>`
    : `<span class="tile-corner ready" title="Ready to launch — no setup needed">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>
        ready
      </span>`;
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
  const wrapCls = t.isAgentInit
    ? "app-tile-wrap agent-init"
    : "app-tile-wrap ready";
  return `<div class="${wrapCls}" data-template-id="${escapeHtml(t.id)}">
    ${badge}${menuBtn}
    <button class="app-tile" data-template-id="${escapeHtml(t.id)}" data-template-name="${escapeHtml(name)}" data-launchable="${opts.launchable ? "1" : "0"}"${dataAttr}>
      <div class="icon" style="background:linear-gradient(135deg, hsl(${hue}, 80%, 70%) 0%, hsl(${(hue + 30) % 360}, 75%, 60%) 100%);">${escapeHtml(initials)}</div>
      <div class="label">${escapeHtml(name)}</div>
    </button>
    ${paneCountChip}
  </div>`;
}

function recentCard(p: PaneRef): string {
  const tplName = p.templateName ?? p.title ?? p.id;
  const hue = paneHue(p.id);
  const initials = paneInitials(tplName);
  const rel = relativeDate(p.createdAt);
  return `<a class="recent-card" href="/panes/${encodeURIComponent(p.id)}">
    <div class="thumb" style="background:linear-gradient(135deg, hsl(${hue}, 80%, 70%) 0%, hsl(${(hue + 30) % 360}, 75%, 60%) 100%);">
      <span class="glyph">${escapeHtml(initials)}</span>
      ${p.templateVersion > 0 ? `<span class="tag">v${p.templateVersion}</span>` : ""}
    </div>
    <div class="title">${escapeHtml(p.title)}</div>
    <div class="meta"><span>${escapeHtml(tplName)}</span><span>${escapeHtml(rel)}</span></div>
  </a>`;
}

function paneRow(p: PaneRef): string {
  const tplName = p.templateName ?? p.title ?? p.id;
  const hue = paneHue(p.id);
  const initials = paneInitials(tplName);
  const rel = relativeDate(p.createdAt);
  const isOpen = p.status === "open" && p.expiresAt.getTime() > Date.now();
  const statusCls = isOpen ? "open" : "closed";
  const statusText = isOpen ? "open" : "closed";
  const tplAttr = p.templateId
    ? ` data-template-id="${escapeHtml(p.templateId)}"`
    : "";
  const starCls = p.isFavorite ? "row-star active" : "row-star";
  const starLabel = p.isFavorite ? "Unfavorite" : "Favorite";
  const starPath = p.isFavorite
    ? `<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01L12 2z" fill="currentColor"/>`
    : `<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01L12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`;
  return `<li class="pane-row" data-pane-id="${escapeHtml(p.id)}" data-href="/panes/${encodeURIComponent(p.id)}"${tplAttr}>
    <div class="icon" style="background:linear-gradient(135deg, hsl(${hue}, 80%, 70%) 0%, hsl(${(hue + 30) % 360}, 75%, 60%) 100%);">${escapeHtml(initials)}</div>
    <div class="info">
      <div class="title">${escapeHtml(p.title)}</div>
      <div class="meta">${escapeHtml(p.id)} · ${escapeHtml(tplName)} · ${escapeHtml(rel)}</div>
    </div>
    <div class="status ${statusCls}">${statusText}</div>
    <button class="${starCls}" data-noopen="1" data-pane-fav-toggle="${escapeHtml(p.id)}" data-fav-on="${p.isFavorite ? "1" : "0"}" title="${escapeHtml(starLabel)}" aria-label="${escapeHtml(starLabel)}">
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">${starPath}</svg>
    </button>
    <button class="menu-btn" title="More" aria-label="More" data-noopen="1" data-pane-menu="${escapeHtml(p.id)}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>
    </button>
  </li>`;
}

// ----- helpers -----

function dedupTemplates<T extends { id: string }>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of arr) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function friendlyName(email: string): string {
  const local = (email.split("@")[0] ?? "").split(/[._-]/)[0] ?? "";
  if (local.length === 0) return "there";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// A template is "agent-init" when its latest version's input_schema declares
// a non-empty `required` array. This matches the convention the relay already
// uses (input_data is validated against the version's input_schema): if the
// schema has required fields, the template can't be launched cold by a human.
function hasRequiredInputs(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) && required.length > 0;
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
  .pane-row:focus-within { outline: 2px solid var(--brand-1); outline-offset: 2px; }
  .recent-card { text-decoration: none; color: inherit; }
  .app-tile, .fav-tile { font: inherit; }
  .fav-tile, .app-tile { background: transparent; border: none; }
  .btn.danger { color: var(--pink); border-color: rgba(251,113,133,0.3); }
  .btn.danger:hover { color: var(--pink); border-color: var(--pink); }

  /* Tile wrap holds the tile + the "X panes →" footer chip. */
  .app-tile-wrap { position: relative; display: flex; flex-direction: column; }
  .app-tile-wrap .pane-count-chip {
    margin-top: 4px; padding: 4px 8px; font-size: 11px;
    background: transparent; border: 1px solid rgba(255,255,255,0.10);
    color: var(--ink-mute); border-radius: 4px; cursor: pointer;
    align-self: flex-start; transition: color 120ms, border-color 120ms;
    font: inherit; line-height: 1.2;
  }
  .app-tile-wrap .pane-count-chip:hover {
    color: var(--brand-1); border-color: rgba(147, 197, 253, 0.4);
  }

  /* Star toggle on each pane row — sits before the triple-dots menu. */
  .pane-row .row-star {
    background: transparent; border: none; color: var(--ink-mute);
    cursor: pointer; padding: 6px; border-radius: 6px;
    display: inline-flex; align-items: center; justify-content: center;
    transition: color 120ms, transform 120ms;
  }
  .pane-row .row-star:hover { color: var(--brand-1); transform: scale(1.08); }
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
  .filter-banner strong { color: var(--brand-1); font-weight: 600; }
  .filter-banner button {
    background: transparent; border: 1px solid rgba(255,255,255,0.10);
    color: var(--ink-mute); padding: 4px 10px; border-radius: 4px;
    cursor: pointer; font: inherit; font-size: 12px;
  }
  .filter-banner button:hover { color: var(--ink); border-color: rgba(255,255,255,0.20); }

  /* "agent-init" / "ready" corner badge — top-left of every template
     tile. Bigger, brighter, and paired with an icon so the type
     registers at a glance (previous 10px text pill was missable). */
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
  .tile-corner.ready {
    color: #ccfbf1;
    background: rgba(20, 184, 166, 0.28);
    border: 1px solid rgba(94, 234, 212, 0.50);
    box-shadow: 0 0 0 1px rgba(20, 184, 166, 0.10) inset;
  }

  /* Triple-dots menu trigger on owned + installed tiles. Top-right;
     mirrors the corner-badge position on the left. */
  .app-tile-wrap .tile-menu-btn {
    position: absolute; top: 6px; right: 6px; z-index: 2;
    width: 26px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(10,13,20,0.55); border: 1px solid rgba(255,255,255,0.08);
    color: var(--ink-mute); border-radius: 6px; cursor: pointer; padding: 0;
    backdrop-filter: blur(4px); transition: color 120ms, transform 120ms;
  }
  .app-tile-wrap .tile-menu-btn:hover { color: var(--ink); transform: scale(1.06); }

  /* Subtle outer accent on the wrap so the type carries even without
     a visible badge (e.g. when scrolling fast / dense grid). */
  .app-tile-wrap.agent-init .app-tile { box-shadow: inset 0 0 0 1px rgba(168, 85, 247, 0.18); }
  .app-tile-wrap.ready .app-tile { box-shadow: inset 0 0 0 1px rgba(20, 184, 166, 0.18); }

  /* Lightweight floating popover for pane-row triple-dots menu. */
  .pane-menu-pop {
    position: fixed; z-index: 1000; min-width: 180px; padding: 4px;
    background: #0f1320; border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px; box-shadow: 0 12px 30px rgba(0,0,0,0.45);
    display: flex; flex-direction: column;
  }
  .pane-menu-pop button {
    background: transparent; border: none; color: var(--ink, #e5e7eb);
    text-align: left; padding: 8px 10px; font: inherit; cursor: pointer;
    border-radius: 5px; font-size: 13px;
  }
  .pane-menu-pop button:hover { background: rgba(255,255,255,0.04); }
  .pane-menu-pop button.danger { color: var(--pink, #fb7185); }
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
  const VIEWS = ['home', 'panes', 'store', 'mine'];
  function activate(view) {
    // Back-compat: prior builds used the hashes "#apps" / "#templates" /
    // "#trash". Remap them so old links / browser-back state still land
    // somewhere sensible.
    if (view === 'apps' || view === 'templates') view = 'mine';
    if (view === 'trash') view = 'home';
    if (!VIEWS.includes(view)) view = 'home';
    document.querySelectorAll('.view').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-view') === view);
    });
    document.querySelectorAll('#nav-items button').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-view') === view);
    });
    if ('#' + view !== location.hash) {
      history.replaceState(null, '', '#' + view);
    }
    // Scroll the active view back to the top so a re-activation feels fresh.
    document.querySelector('.main').scrollTop = 0;
  }
  function viewFromHash() {
    const h = (location.hash || '').replace(/^#/, '');
    return VIEWS.includes(h) ? h : 'home';
  }

  // Nav clicks
  document.querySelectorAll('#nav-items button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => activate(btn.getAttribute('data-view')));
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

  // Sign out
  document.getElementById('signout')?.addEventListener('click', async () => {
    try { await fetch('/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    location.href = '/login';
  });

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
    const needsInstall = tile.getAttribute('data-needs-install') === '1';
    const labelEl = tile.querySelector('.label');
    const origLabel = labelEl ? labelEl.textContent : '';
    function reset() {
      if (labelEl) labelEl.textContent = origLabel;
      tile.disabled = false;
    }
    tile.disabled = true;
    try {
      if (needsInstall) {
        if (labelEl) labelEl.textContent = 'Installing…';
        const ins = await fetch('/v1/templates/' + encodeURIComponent(id) + '/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: '{}',
        });
        if (!ins.ok) {
          reset();
          const body = await ins.json().catch(() => ({}));
          alert('Install failed: ' + ((body.error && body.error.message) || ('HTTP ' + ins.status)));
          return;
        }
      }
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
          const navCount = document.querySelector('#nav-items button[data-view="mine"] .count');
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
  bindSearch('home-search', ['#favs .fav-tile', '#recents .recent-card', '#home-apps .app-tile-wrap']);
  bindSearch('store-search', ['#apps-discover .app-tile-wrap']);
  bindSearch('mine-search', ['#apps-mine .app-tile-wrap', '#apps-installed .app-tile-wrap']);

  // Initial view selection from the URL hash.
  activate(viewFromHash());
})();
`;
