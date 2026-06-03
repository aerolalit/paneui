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
  /** True when this template is currently starred by the human. */
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
  /** Templates the human has starred — independent of install. */
  favorites: TemplateRef[];
  /** Panes the human owns or has joined as participant, ordered newest first. */
  panes: Array<{
    id: string;
    title: string;
    status: string;
    createdAt: Date;
    expiresAt: Date;
    templateVersion: number;
    templateName: string | null;
  }>;
  /** Soft-deleted templates + panes (the trash view). */
  trash: Array<{
    kind: "pane" | "template";
    id: string;
    name: string;
    deletedAt: Date;
  }>;
}

async function loadShellData(
  prisma: PrismaClient,
  human: HumanRow,
): Promise<ShellData> {
  // One human owns N claimed agents; their templates are the "Yours"
  // section. We resolve the agent set once and reuse it for both the
  // template list and the trash query.
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
    panes,
    trashedTemplates,
    trashedPanes,
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
            template: { select: { name: true, slug: true } },
          },
        },
      },
    }),
    claimedAgentIds.length === 0
      ? Promise.resolve([])
      : prisma.template.findMany({
          where: {
            ownerId: { in: claimedAgentIds },
            deletedAt: { not: null },
          },
          orderBy: { deletedAt: "desc" },
          take: 50,
          select: {
            id: true,
            name: true,
            slug: true,
            deletedAt: true,
          },
        }),
    prisma.pane.findMany({
      where: {
        ownerHumanId: human.id,
        deletedAt: { not: null },
      },
      orderBy: { deletedAt: "desc" },
      take: 50,
      select: {
        id: true,
        title: true,
        deletedAt: true,
      },
    }),
    prisma.humanTemplateFavorite.findMany({
      where: { humanId: human.id },
      orderBy: { addedAt: "desc" },
      select: {
        template: {
          select: {
            id: true,
            name: true,
            slug: true,
            deletedAt: true,
            ...latestVersionInclude,
          },
        },
      },
    }),
  ]);

  const favoriteIds = new Set(favoriteRows.map((f) => f.template.id));
  function toRef(t: {
    id: string;
    name: string | null;
    slug: string | null;
    versions: Array<{ inputSchema: unknown }>;
  }): TemplateRef {
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      isAgentInit: hasRequiredInputs(t.versions[0]?.inputSchema),
      isFavorite: favoriteIds.has(t.id),
    };
  }
  const ownedTemplates = ownedTemplatesRaw.map(toRef);

  const liveInstalls = installs.filter((i) => i.template.deletedAt === null);
  const installedIds = new Set(liveInstalls.map((i) => i.template.id));
  const publicCatalog = publicCatalogRaw
    .filter((t) => !installedIds.has(t.id))
    .map(toRef);
  const favorites = favoriteRows
    .filter((f) => f.template.deletedAt === null)
    .map((f) => toRef(f.template));

  const trash: ShellData["trash"] = [
    ...trashedTemplates.map((t) => ({
      kind: "template" as const,
      id: t.id,
      name: t.name ?? t.slug ?? t.id,
      deletedAt: t.deletedAt!,
    })),
    ...trashedPanes.map((p) => ({
      kind: "pane" as const,
      id: p.id,
      name: p.title,
      deletedAt: p.deletedAt!,
    })),
  ].sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());

  return {
    ownedTemplates,
    installs: liveInstalls.map((i) => ({
      template: toRef(i.template),
      installedVersion: i.installedVersion,
    })),
    publicCatalog,
    favorites,
    panes: panes.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      templateVersion: p.templateVersion?.version ?? 0,
      templateName:
        p.templateVersion?.template?.name ??
        p.templateVersion?.template?.slug ??
        null,
    })),
    trash,
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

  // Build the favorites strip from the favorites table (independent of installs).
  const favsHtml =
    data.favorites.length === 0
      ? `<div class="empty-strip">No favorites yet. Tap the star on a template to pin it here.</div>`
      : data.favorites
          .slice(0, 12)
          .map((t) => favTile(t))
          .join("");

  // Recents strip from panes.
  const recentsHtml =
    data.panes.length === 0
      ? `<div class="empty-strip">No open panes. Launch one from the Templates view.</div>`
      : data.panes
          .slice(0, 8)
          .map((p) => recentCard(p))
          .join("");

  // Home "All templates" grid — owned + installed deduped (by id, preserving
  // the merged isFavorite flag from whichever copy appeared first).
  const homeAllTemplates = dedupTemplates([
    ...data.ownedTemplates,
    ...data.installs.map((i) => i.template),
  ]);
  const homeAppsHtml =
    homeAllTemplates.length === 0
      ? `<div class="empty-strip" style="grid-column:1/-1;">Your library is empty. Install one from the catalog or run <code>pane template create</code>.</div>`
      : homeAllTemplates.map((t) => appTile(t, { launchable: true })).join("");

  // Templates view grids.
  const minesHtml =
    data.ownedTemplates.length === 0
      ? `<div class="empty-strip" style="grid-column:1/-1;">No templates yet. Run <code>pane template create</code> from a claimed agent.</div>`
      : data.ownedTemplates
          .map((t) => appTile(t, { launchable: true }))
          .join("");
  const installedHtml =
    data.installs.length === 0
      ? `<div class="empty-strip" style="grid-column:1/-1;">No installs yet.</div>`
      : data.installs
          .map((i) => appTile(i.template, { launchable: true }))
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
      ? `<li class="empty-strip">No live panes. Launch one from <a data-go="templates" style="color:var(--brand-1);cursor:pointer;">Templates</a>.</li>`
      : data.panes.map((p) => paneRow(p)).join("");

  // Trash list.
  const trashHtml =
    data.trash.length === 0
      ? `<li class="empty-strip">Trash is empty.</li>`
      : data.trash.map((it) => trashRow(it)).join("");

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
        <span class="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12L12 3l9 9"/><path d="M5 10v10h14V10"/></svg></span>
        <span class="label">Home</span>
      </button></li>
      <li><button data-view="templates">
        <span class="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></span>
        <span class="label">Templates</span>
        <span class="count">${tplLibraryCount}</span>
      </button></li>
      <li><button data-view="panes">
        <span class="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg></span>
        <span class="label">Panes</span>
        <span class="count">${panesCount}</span>
      </button></li>
      <li><button data-view="trash">
        <span class="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></span>
        <span class="label">Trash</span>
      </button></li>
    </ul>
    <div class="me">
      <div class="avatar">${escapeHtml(avatarLetter)}</div>
      <div class="who">
        <div class="name">${escapeHtml(displayName)}</div>
        <div class="sub">${escapeHtml(human.email)}</div>
      </div>
      <button id="signout" title="Sign out" aria-label="Sign out" style="margin-left:auto;background:transparent;border:none;color:var(--ink-mute);cursor:pointer;padding:6px;border-radius:6px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </button>
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
          <a data-go="templates">Edit</a>
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
          <a data-go="templates">Browse catalog →</a>
        </div>
        <div class="apps-grid" id="home-apps">${homeAppsHtml}</div>
      </div>
    </section>

    <section class="view" data-view="templates">
      <div class="view-head">
        <div>
          <h1>Templates</h1>
          <div class="sub">Apps you can launch into a pane.</div>
        </div>
      </div>
      <div class="search">
        <span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg></span>
        <input id="apps-search" placeholder="Search templates…" autocomplete="off" />
      </div>

      <div class="cat-row"><h3>Yours</h3><span class="count">${data.ownedTemplates.length}</span></div>
      <div class="apps-grid" id="apps-mine">${minesHtml}</div>

      <div class="cat-row"><h3>Installed from catalog</h3><span class="count">${data.installs.length}</span></div>
      <div class="apps-grid" id="apps-installed">${installedHtml}</div>

      <div class="cat-row"><h3>Discover</h3><span class="count">${data.publicCatalog.length}</span></div>
      <div class="apps-grid" id="apps-discover">${discoverHtml}</div>
    </section>

    <section class="view" data-view="panes">
      <div class="view-head">
        <div>
          <h1>Panes</h1>
          <div class="sub">Live sessions you own or joined. Click to open.</div>
        </div>
      </div>
      <ul class="panes-list" id="panes-list">${panesHtml}</ul>
    </section>

    <section class="view" data-view="trash">
      <div class="view-head">
        <div>
          <h1>Trash</h1>
          <div class="sub">Soft-deleted apps + panes. Restore within 30 days, then auto-purged.</div>
        </div>
      </div>
      <ul class="trash-list" id="trash-list">${trashHtml}</ul>
    </section>

  </main>
</div>

<script>${SHELL_JS}</script>
</body>
</html>`;
}

// ----- Tile / row HTML helpers -----

function favTile(t: TemplateRef): string {
  const name = t.name ?? t.slug ?? t.id;
  const hue = paneHue(t.id);
  const initials = paneInitials(name);
  return `<button class="fav-tile" data-template-id="${escapeHtml(t.id)}" data-template-name="${escapeHtml(name)}">
    <div class="icon" style="background:linear-gradient(135deg, hsl(${hue}, 80%, 70%) 0%, hsl(${(hue + 30) % 360}, 75%, 60%) 100%);">${escapeHtml(initials)}</div>
    <div class="label">${escapeHtml(name)}</div>
  </button>`;
}

function appTile(
  t: TemplateRef,
  opts: { launchable: boolean; install?: boolean },
): string {
  const name = t.name ?? t.slug ?? t.id;
  const hue = paneHue(t.id);
  const initials = paneInitials(name);
  const dataAttr = opts.install ? ` data-needs-install="1"` : "";
  const badge = t.isAgentInit
    ? `<span class="tile-badge agent-init" title="Needs an agent to set input data before launch">agent-init</span>`
    : `<span class="tile-badge ready" title="Ready to launch — no setup needed">ready</span>`;
  const starCls = t.isFavorite ? "star active" : "star";
  const starLabel = t.isFavorite ? "Unfavorite" : "Favorite";
  const starPath = t.isFavorite
    ? `<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01L12 2z" fill="currentColor"/>`
    : `<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01L12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`;
  return `<div class="app-tile-wrap" data-template-id="${escapeHtml(t.id)}">
    <button class="app-tile" data-template-id="${escapeHtml(t.id)}" data-template-name="${escapeHtml(name)}" data-launchable="${opts.launchable ? "1" : "0"}"${dataAttr}>
      <div class="icon" style="background:linear-gradient(135deg, hsl(${hue}, 80%, 70%) 0%, hsl(${(hue + 30) % 360}, 75%, 60%) 100%);">${escapeHtml(initials)}</div>
      <div class="label">${escapeHtml(name)}</div>
      ${badge}
    </button>
    <button class="${starCls}" data-fav-toggle="${escapeHtml(t.id)}" data-fav-on="${t.isFavorite ? "1" : "0"}" title="${escapeHtml(starLabel)}" aria-label="${escapeHtml(starLabel)}">
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">${starPath}</svg>
    </button>
  </div>`;
}

function recentCard(p: ShellData["panes"][number]): string {
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

function paneRow(p: ShellData["panes"][number]): string {
  const tplName = p.templateName ?? p.title ?? p.id;
  const hue = paneHue(p.id);
  const initials = paneInitials(tplName);
  const rel = relativeDate(p.createdAt);
  const isOpen = p.status === "open" && p.expiresAt.getTime() > Date.now();
  const statusCls = isOpen ? "open" : "closed";
  const statusText = isOpen ? "open" : "closed";
  return `<li class="pane-row" data-pane-id="${escapeHtml(p.id)}" data-href="/panes/${encodeURIComponent(p.id)}">
    <div class="icon" style="background:linear-gradient(135deg, hsl(${hue}, 80%, 70%) 0%, hsl(${(hue + 30) % 360}, 75%, 60%) 100%);">${escapeHtml(initials)}</div>
    <div class="info">
      <div class="title">${escapeHtml(p.title)}</div>
      <div class="meta">${escapeHtml(p.id)} · ${escapeHtml(tplName)} · ${escapeHtml(rel)}</div>
    </div>
    <div class="status ${statusCls}">${statusText}</div>
    <button class="menu-btn" title="More" aria-label="More" data-noopen="1" data-pane-menu="${escapeHtml(p.id)}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>
    </button>
  </li>`;
}

function trashRow(it: ShellData["trash"][number]): string {
  const kindLabel = it.kind === "pane" ? "Pane" : "Template";
  const rel = relativeDate(it.deletedAt);
  return `<li>
    <div><div class="name">${escapeHtml(kindLabel)} — ${escapeHtml(it.name)}</div>
    <div class="when">${escapeHtml(it.id)} · deleted ${escapeHtml(rel)}</div></div>
    <div class="trash-actions">
      <button class="btn" data-trash-act="restore" data-trash-kind="${escapeHtml(it.kind)}" data-trash-id="${escapeHtml(it.id)}">Restore</button>
      <button class="btn danger" data-trash-act="purge" data-trash-kind="${escapeHtml(it.kind)}" data-trash-id="${escapeHtml(it.id)}">Purge</button>
    </div>
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

  /* Tile wrap holds the tile + the floating star toggle. */
  .app-tile-wrap { position: relative; }
  .app-tile-wrap .star {
    position: absolute; top: 6px; right: 6px; width: 24px; height: 24px;
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(10,13,20,0.55); border: 1px solid rgba(255,255,255,0.08);
    color: var(--ink-mute); border-radius: 6px; cursor: pointer; padding: 0;
    backdrop-filter: blur(4px); transition: color 120ms, transform 120ms;
  }
  .app-tile-wrap .star:hover { color: var(--brand-1); transform: scale(1.06); }
  .app-tile-wrap .star.active { color: #fbbf24; }
  .app-tile-wrap .star.active:hover { color: #fbbf24; }

  /* "agent-init" / "ready" pill on every template tile. */
  .tile-badge {
    display: inline-block; font-size: 10px; line-height: 1; padding: 3px 6px;
    border-radius: 4px; margin-top: 6px; letter-spacing: 0.02em;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  .tile-badge.agent-init { color: #c4b5fd; background: rgba(196,181,253,0.12); border: 1px solid rgba(196,181,253,0.25); }
  .tile-badge.ready { color: #5eead4; background: rgba(94,234,212,0.10); border: 1px solid rgba(94,234,212,0.22); }

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
//      new pane.
//   4. Search inputs filter visible tiles/rows live.
//   5. Trash buttons (Restore / Purge) hit /v1/my-trash/* and reload.
//   6. Sign-out → POST /v1/auth/logout → /login.

const SHELL_JS = `
(function () {
  const VIEWS = ['home', 'templates', 'panes', 'trash'];
  function activate(view) {
    // Back-compat: the previous build used the hash "#apps" — silently
    // remap so existing bookmarks / browser-back state still land somewhere
    // sensible.
    if (view === 'apps') view = 'templates';
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

  // Star toggle on a tile — POST/DELETE the favorite, then update the icon
  // in place. Avoids a full reload so the user stays in flow.
  document.body.addEventListener('click', async (ev) => {
    const star = ev.target instanceof HTMLElement && ev.target.closest('button[data-fav-toggle]');
    if (!star) return;
    ev.preventDefault();
    ev.stopPropagation();
    const id = star.getAttribute('data-fav-toggle');
    if (!id) return;
    const on = star.getAttribute('data-fav-on') === '1';
    const method = on ? 'DELETE' : 'POST';
    star.disabled = true;
    try {
      const res = await fetch('/v1/my-templates/' + encodeURIComponent(id) + '/favorite', {
        method, credentials: 'same-origin',
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        alert('Favorite failed: ' + ((body.error && body.error.message) || ('HTTP ' + res.status)));
        return;
      }
      const newOn = !on;
      // Update every tile referencing this template (same id can appear
      // in multiple grids — Yours, Installed, Home All-templates).
      document.querySelectorAll('button[data-fav-toggle="' + CSS.escape(id) + '"]').forEach((el) => {
        const wantOn = newOn;
        el.setAttribute('data-fav-on', wantOn ? '1' : '0');
        el.setAttribute('title', wantOn ? 'Unfavorite' : 'Favorite');
        el.setAttribute('aria-label', wantOn ? 'Unfavorite' : 'Favorite');
        el.classList.toggle('active', wantOn);
        const svg = el.querySelector('svg');
        if (svg) {
          svg.innerHTML = wantOn
            ? '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01L12 2z" fill="currentColor"/>'
            : '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77 5.82 21l1.18-6.88-5-4.87 6.91-1.01L12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>';
        }
      });
    } catch (e) {
      alert('Network error — try again.');
    } finally {
      star.disabled = false;
    }
  });

  // Tile click → launch (for installed/owned) or 404 (discover; would
  // need an install first). We route through the existing cookie-authed
  // launch endpoint; on failure we surface the relay's error message.
  document.body.addEventListener('click', async (ev) => {
    // Star toggle is handled by its own listener above; bail early so we
    // don't trigger launch when the user clicks the star.
    if (ev.target instanceof HTMLElement && ev.target.closest('button[data-fav-toggle]')) return;
    const tile = ev.target instanceof HTMLElement &&
      (ev.target.closest('.fav-tile') || ev.target.closest('.app-tile'));
    if (!tile) return;
    const id = tile.getAttribute('data-template-id');
    if (!id) return;
    const needsInstall = tile.getAttribute('data-needs-install') === '1';
    if (needsInstall) {
      // For now, send the user to the existing /my-templates page where
      // they can install. A future iteration can install + launch inline.
      alert('Install this template from /my-templates first, then launch it.');
      return;
    }
    const labelEl = tile.querySelector('.label');
    const origLabel = labelEl ? labelEl.textContent : '';
    if (labelEl) labelEl.textContent = 'Launching…';
    tile.disabled = true;
    try {
      const res = await fetch('/v1/my-templates/' + encodeURIComponent(id) + '/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        if (labelEl) labelEl.textContent = origLabel;
        tile.disabled = false;
        const body = await res.json().catch(() => ({}));
        alert('Launch failed: ' + ((body.error && body.error.message) || ('HTTP ' + res.status)));
        return;
      }
      const body = await res.json();
      const url = body.urls && body.urls.humans && body.urls.humans[0];
      if (url) location.href = url;
    } catch (e) {
      if (labelEl) labelEl.textContent = origLabel;
      tile.disabled = false;
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
  bindSearch('apps-search', ['#apps-mine .app-tile-wrap', '#apps-installed .app-tile-wrap', '#apps-discover .app-tile-wrap']);

  // Trash actions
  document.body.addEventListener('click', async (ev) => {
    const btn = ev.target instanceof HTMLElement && ev.target.closest('button[data-trash-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-trash-act');
    const kind = btn.getAttribute('data-trash-kind');
    const id = btn.getAttribute('data-trash-id');
    if (!act || !kind || !id) return;
    if (act === 'purge' && !confirm('Permanently delete this ' + kind + '? This can\\'t be undone.')) return;
    const path = '/v1/my-trash/' + encodeURIComponent(kind) + 's/' + encodeURIComponent(id) +
      (act === 'restore' ? '/restore' : '');
    const method = act === 'restore' ? 'POST' : 'DELETE';
    btn.disabled = true;
    try {
      const res = await fetch(path, { method, credentials: 'same-origin' });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        alert('Failed: ' + ((body.error && body.error.message) || ('HTTP ' + res.status)));
        btn.disabled = false;
        return;
      }
      // Reload to re-render the trash list with the row removed.
      location.reload();
    } catch (e) {
      btn.disabled = false;
      alert('Network error — try again.');
    }
  });

  // Initial view selection from the URL hash.
  activate(viewFromHash());
})();
`;
