// System pages — the bootstrap UI for a logged-in human.
//
//   GET  /login              static login form (email entry)
//   GET  /home               home page: favourites + links to other system pages
//   GET  /my-surfaces        list of surfaces the human participates on
//   GET  /my-templates       list of templates the human owns
//   GET  /my-agents          list of claimed agents + claim-new button
//   GET  /settings           email, home pick, logout
//
// Trust model: these pages are pane-shipped HTML (full-trust, same-origin
// fetches), NOT sandboxed iframes like agent templates. They use the
// Login cookie directly via window.fetch to /v1/self/* and /v1/agents/*.
//
// Architectural note: §5.2 says the home should be a TEMPLATE in DB
// (Surface row + Template row). For Phase D MVP these are direct HTML
// routes; templatising them is a follow-up refactor that doesn't change
// behaviour. See HUMAN-SIDE-PROPOSAL.md "Open decisions" tail.

import { Hono } from "hono";
import {
  resolveHumanOptional,
  type OptionalHumanAuthEnv,
} from "../../auth/human-auth.js";

const systemPages = new Hono<OptionalHumanAuthEnv>();

systemPages.use("*", resolveHumanOptional);

// The Pane brand mark — same shape as the surface shell's header logo
// (src/bridge/routes.ts) so the system pages and the live surface read as one
// product. Inlined as an SVG element (not a data URI) so it inherits crisp
// rendering at the header size.
const BRAND_LOGO = `<svg width="22" height="22" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
  <rect width="100" height="100" rx="22" fill="#0f172a"/>
  <circle cx="62" cy="58" r="17" fill="#22d3ee"/>
  <rect x="20" y="26" width="40" height="32" rx="10" fill="#0f172a"/>
  <rect x="24" y="30" width="32" height="24" rx="7" fill="#a78bfa"/>
  <circle cx="33.5" cy="42" r="3.4" fill="#0f172a"/>
  <circle cx="46.5" cy="42" r="3.4" fill="#0f172a"/>
</svg>`;

// Shared layout primitives — every system page wraps its body in this
// shell so the visual identity is uniform.
//
// Mobile: the page is mobile-first. The header splits into two rows — a brand
// bar and a horizontally scrollable tab strip — so the nav never overflows or
// wraps awkwardly on a phone. A `prefers-color-scheme: dark` block maps the
// palette onto the same navy the surface shell uses.
function layout(args: {
  title: string;
  email: string | null;
  body: string;
  /** Slug of the current page (e.g. "home"). Highlights the nav link. */
  active?: string;
}): string {
  const nav = (slug: string, label: string, href: string) => {
    const cls = args.active === slug ? "tab active" : "tab";
    return `<a class="${cls}" href="${href}"${args.active === slug ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
  };
  const accountBlock = args.email
    ? `<span class="acct-email" title="${escapeHtml(args.email)}">${escapeHtml(args.email)}</span>
       <button id="pane-logout" class="acct-signout" type="button">Sign out</button>`
    : `<a class="acct-signin" href="/login">Sign in</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#0b0e14" media="(prefers-color-scheme: dark)" />
<title>${escapeHtml(args.title)} · pane</title>
<style>
  :root {
    --bg: #f6f7f9;
    --panel: #ffffff;
    --fg: #101522;
    --muted: #5d6577;
    --rule: #e7e9ef;
    --accent: #6d5ef0;
    --accent-hover: #5b4bd8;
    --accent-soft: #efedfd;
    --accent-border: #d9d4f7;
    --accent-ink: #4b3fb0;
    --code-bg: #f1f2f6;
    --good: #1f8a4c;
    --good-soft: #e6f4ec;
    --shadow: 0 1px 2px rgba(16,21,34,.04), 0 1px 3px rgba(16,21,34,.06);
    --shadow-lg: 0 6px 24px rgba(16,21,34,.10);
    --radius: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0e14;
      --panel: #11151e;
      --fg: #e7ecf3;
      --muted: #8a93a6;
      --rule: #1f2633;
      --accent: #a78bfa;
      --accent-hover: #b9a4ff;
      --accent-soft: #1a1b30;
      --accent-border: #2f2c52;
      --accent-ink: #cdbcff;
      --code-bg: #141a26;
      --good: #7CE3B1;
      --good-soft: #11261b;
      --shadow: none;
      --shadow-lg: 0 8px 28px rgba(0,0,0,.45);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; font-size: 16px; line-height: 1.55; -webkit-font-smoothing: antialiased; }

  header.pane-nav {
    position: sticky; top: 0; z-index: 20;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    backdrop-filter: saturate(180%) blur(12px);
    border-bottom: 1px solid var(--rule);
    padding-top: env(safe-area-inset-top);
  }
  header.pane-nav .bar {
    max-width: 920px; margin: 0 auto;
    padding: 12px max(16px, env(safe-area-inset-left)) 12px max(16px, env(safe-area-inset-right));
    display: flex; align-items: center; gap: 12px;
  }
  header.pane-nav .brand { display: inline-flex; align-items: center; gap: 9px; text-decoration: none; color: var(--fg); flex: none; }
  header.pane-nav .brand svg { display: block; border-radius: 7px; }
  header.pane-nav .brand .wordmark { font-weight: 700; font-size: 16px; letter-spacing: -0.02em; }
  header.pane-nav .account { display: flex; align-items: center; gap: 10px; margin-left: auto; min-width: 0; }
  .acct-email { font-size: 13px; color: var(--muted); max-width: 36vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acct-signout { background: transparent; border: 1px solid var(--rule); color: var(--muted); font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 8px; cursor: pointer; flex: none; }
  .acct-signout:hover { border-color: var(--accent); color: var(--accent); }
  .acct-signin { color: var(--accent); font-size: 14px; font-weight: 600; text-decoration: none; }

  header.pane-nav .tabs {
    max-width: 920px; margin: 0 auto;
    padding: 0 max(8px, env(safe-area-inset-left)) 0 max(8px, env(safe-area-inset-right));
    display: flex; gap: 2px;
    overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
  }
  header.pane-nav .tabs::-webkit-scrollbar { display: none; }
  .tab {
    flex: none; text-decoration: none; color: var(--muted);
    font-size: 14px; font-weight: 500; line-height: 1;
    padding: 11px 12px; border-bottom: 2px solid transparent;
    white-space: nowrap;
  }
  .tab:hover { color: var(--fg); }
  .tab.active { color: var(--accent); font-weight: 600; border-bottom-color: var(--accent); }

  main { max-width: 920px; margin: 0 auto; padding: 24px 16px calc(80px + env(safe-area-inset-bottom)); }
  @media (min-width: 640px) { main { padding: 36px 28px 96px; } }

  h1 { font-size: 22px; letter-spacing: -0.015em; margin: 0 0 8px; }
  @media (min-width: 640px) { h1 { font-size: 27px; } }
  h2 { font-size: 17px; margin: 26px 0 10px; letter-spacing: -0.01em; }
  p { margin: 0 0 14px; }
  a { color: var(--accent); }

  .card { background: var(--panel); border: 1px solid var(--rule); border-radius: var(--radius); padding: 18px; margin-bottom: 14px; box-shadow: var(--shadow); }
  @media (min-width: 640px) { .card { padding: 22px 24px; } }

  .list { list-style: none; padding: 0; margin: 0; }
  .list li { padding: 14px 0; border-bottom: 1px solid var(--rule); display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .list li:first-child { padding-top: 4px; }
  .list li:last-child { border-bottom: none; padding-bottom: 4px; }
  .list li > div:first-child { min-width: 0; flex: 1 1 auto; }
  .list li .title { font-weight: 600; overflow-wrap: anywhere; }
  .list li .meta { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; margin-top: 2px; }

  .empty { color: var(--muted); padding: 28px 12px; text-align: center; }

  button.btn, a.btn { font: inherit; font-size: 14px; font-weight: 600; padding: 10px 16px; border-radius: 9px; cursor: pointer; border: 1px solid transparent; background: var(--accent); color: #fff; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; min-height: 40px; transition: background .12s ease, border-color .12s ease, color .12s ease; }
  button.btn:hover, a.btn:hover { background: var(--accent-hover); }
  button.btn:active, a.btn:active { transform: translateY(1px); }
  button.btn:disabled { opacity: .6; cursor: default; }
  button.btn.ghost, a.btn.ghost { background: var(--panel); color: var(--fg); border-color: var(--rule); }
  button.btn.ghost:hover, a.btn.ghost:hover { background: var(--bg); border-color: var(--accent); color: var(--accent); }

  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }

  label { display: block; }
  input[type=email], input[type=text] { font: inherit; font-size: 16px; padding: 12px 14px; border: 1px solid var(--rule); border-radius: 10px; background: var(--panel); color: var(--fg); width: 100%; outline: none; min-height: 44px; }
  input[type=email]:focus, input[type=text]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

  code { font-family: "SF Mono",Menlo,Consolas,monospace; font-size: 13.5px; background: var(--code-bg); padding: 2px 6px; border-radius: 5px; overflow-wrap: anywhere; }
  pre { font-family: "SF Mono",Menlo,Consolas,monospace; background: var(--code-bg); padding: 14px 16px; border-radius: 10px; overflow-x: auto; font-size: 13px; line-height: 1.5; margin: 0 0 14px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .pill { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; flex: none; }
  .pill.good { background: var(--good-soft); color: var(--good); }
  .pill.muted { background: var(--code-bg); color: var(--muted); }
</style>
</head>
<body>
<header class="pane-nav">
  <div class="bar">
    <a class="brand" href="/home">${BRAND_LOGO}<span class="wordmark">pane</span></a>
    <div class="account">${accountBlock}</div>
  </div>
  <nav class="tabs" aria-label="Primary">
    ${nav("home", "Home", "/home")}
    ${nav("surfaces", "My surfaces", "/my-surfaces")}
    ${nav("templates", "My templates", "/my-templates")}
    ${nav("agents", "My agents", "/my-agents")}
    ${nav("settings", "Settings", "/settings")}
  </nav>
</header>
<main>
  ${args.body}
</main>
<script>
  document.getElementById("pane-logout")?.addEventListener("click", async () => {
    try {
      await fetch("/v1/auth/logout", { method: "POST" });
    } catch {}
    location.href = "/login";
  });
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loggedOutPrompt(): string {
  return `<div class="card">
    <h1>Sign in to see this page</h1>
    <p>This area of pane is only available to signed-in humans. <a href="/login" class="btn">Sign in</a></p>
  </div>`;
}

// ----------------------------------------------------------------------
// GET / — public landing for the relay
//
// The relay's own front door. Previously app.ts 302'd this to
// https://paneui.com so the operator's marketing site swallowed every
// unauthenticated visit; the relay now serves its own page so logged-out
// callers see what this thing IS (and where to sign in) while logged-in
// humans go straight to /home.
// ----------------------------------------------------------------------
systemPages.get("/", (c) => {
  const human = c.get("human");
  if (human) {
    return c.redirect("/home", 302);
  }
  const provider = c.get("emailProvider");
  const signInCta = provider.available
    ? `<a class="btn" href="/login" style="min-width:160px;">Sign in</a>`
    : `<span style="color:var(--muted);font-size:14px;">Human login is disabled on this relay (<code>EMAIL_PROVIDER=none</code>). The agent API is still available.</span>`;
  const body = `<div class="card" style="max-width:560px;margin:24px auto 0;padding:32px 28px;">
      <h1 style="margin:0 0 14px;font-size:28px;letter-spacing:-0.015em;">Pane relay</h1>
      <p style="color:var(--muted);font-size:15px;margin:0 0 18px;">A round-trip UI channel between agents and humans. An agent renders an HTML surface, the relay hands a human the URL, the human's interactions come back to the agent as structured events.</p>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 22px;">${signInCta}</div>
      <h2 style="font-size:14px;letter-spacing:0.04em;text-transform:uppercase;color:var(--muted);margin:18px 0 10px;">For agents</h2>
      <ul class="list">
        <li><div><div class="title">Skill</div><div class="meta">The pane skill, served verbatim. <code>pane skill show</code> fetches this.</div></div><a class="btn ghost" href="/skills/pane/SKILL.md">Open</a></li>
        <li><div><div class="title">Project home</div><div class="meta">Docs, releases, and source.</div></div><a class="btn ghost" href="https://paneui.com" rel="noreferrer">paneui.com</a></li>
      </ul>
    </div>`;
  return c.html(layout({ title: "Pane relay", email: null, body, active: "" }));
});

// ----------------------------------------------------------------------
// GET /login — static login form
// ----------------------------------------------------------------------
systemPages.get("/login", (c) => {
  const provider = c.get("emailProvider");
  const config = c.get("config");
  const human = c.get("human");
  if (human) {
    // Already signed in — bounce to /home rather than re-prompting.
    return c.redirect("/home", 302);
  }
  // Format the magic-link TTL for the success message. Always shown in
  // minutes — sub-minute TTLs round up to "1 minute" since "0 minutes" or
  // "30 seconds" would be more noise than signal on a login page.
  const ttlMinutes = Math.max(
    1,
    Math.round(config.MAGIC_LINK_TTL_SECONDS / 60),
  );
  const ttlLabel = ttlMinutes === 1 ? "1 minute" : `${ttlMinutes} minutes`;
  const body = !provider.available
    ? `<div class="card">
        <h1>Human-side login is disabled</h1>
        <p>This relay is configured with <code>EMAIL_PROVIDER=none</code>; only the agent API and capability-URL surfaces are available.</p>
        <p>If you're operating this relay, configure an email provider (Azure, SMTP, or Resend) and restart.</p>
       </div>`
    : `<div class="card" style="max-width:420px;margin:48px auto 0;">
        <h1>Sign in to pane</h1>
        <p style="color:var(--muted);font-size:14.5px;">We'll email you a one-time sign-in link. No password.</p>
        <form id="login-form" autocomplete="on">
          <label for="email" style="font-size:13px;color:var(--muted);margin-bottom:6px;">Email</label>
          <input id="email" name="email" type="email" required autofocus autocomplete="email" />
          <button class="btn" type="submit" style="width:100%;margin-top:14px;">Email me a link</button>
        </form>
        <p id="login-status" style="margin-top:14px;font-size:14px;color:var(--muted);" aria-live="polite"></p>
       </div>
       <script>
         const form = document.getElementById("login-form");
         const status = document.getElementById("login-status");
         form?.addEventListener("submit", async (e) => {
           e.preventDefault();
           const email = (document.getElementById("email")).value.trim();
           if (!email) return;
           status.textContent = "Sending…";
           try {
             const res = await fetch("/v1/auth/request-link", {
               method: "POST",
               headers: { "content-type": "application/json" },
               body: JSON.stringify({ email }),
             });
             if (res.ok) {
               status.textContent = "Check " + email + " for your sign-in link. It expires in ${ttlLabel}.";
             } else {
               const body = await res.json().catch(() => ({}));
               status.textContent = "Couldn't send: " + (body.error?.message || res.statusText);
             }
           } catch (err) {
             status.textContent = "Network error — try again.";
           }
         });
       </script>`;
  return c.html(layout({ title: "Sign in", email: null, body, active: "" }));
});

// ----------------------------------------------------------------------
// GET /home — favourites + links to other system pages
// ----------------------------------------------------------------------
systemPages.get("/home", async (c) => {
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "Home", email: null, body: loggedOutPrompt() }),
    );
  }
  const prisma = c.get("prisma");
  // Show a few recent surfaces the human owns, as quick links.
  const recent = await prisma.surface.findMany({
    where: { ownerHumanId: human.id },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, title: true, createdAt: true },
  });
  const recentBlock =
    recent.length === 0
      ? `<p class="empty">No surfaces yet.</p>`
      : `<ul class="list">${recent
          .map(
            (s) =>
              `<li><div><div class="title">${escapeHtml(s.title)}</div><div class="meta"><code>${escapeHtml(s.id)}</code></div></div></li>`,
          )
          .join("")}</ul>`;
  const body = `<h1>Welcome back</h1>
  <p style="color:var(--muted);">Signed in as ${escapeHtml(human.email)}.</p>
  <div class="card">
    <h2>Jump in</h2>
    <ul class="list">
      <li><div><div class="title">My surfaces</div><div class="meta">Surfaces you own or are a participant on</div></div><a class="btn ghost" href="/my-surfaces">Open</a></li>
      <li><div><div class="title">My templates</div><div class="meta">Templates owned by your agents</div></div><a class="btn ghost" href="/my-templates">Open</a></li>
      <li><div><div class="title">My agents</div><div class="meta">Agents you've claimed</div></div><a class="btn ghost" href="/my-agents">Open</a></li>
      <li><div><div class="title">Settings</div><div class="meta">Email, claim codes</div></div><a class="btn ghost" href="/settings">Open</a></li>
    </ul>
  </div>
  <div class="card">
    <h2>Recent surfaces</h2>
    ${recentBlock}
  </div>`;
  return c.html(
    layout({
      title: "Home",
      email: human.email,
      body,
      active: "home",
    }),
  );
});

// ----------------------------------------------------------------------
// GET /my-surfaces — list of surfaces the human owns
// ----------------------------------------------------------------------
systemPages.get("/my-surfaces", async (c) => {
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "My surfaces", email: null, body: loggedOutPrompt() }),
    );
  }
  const prisma = c.get("prisma");
  const surfaces = await prisma.surface.findMany({
    where: { ownerHumanId: human.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      createdAt: true,
      expiresAt: true,
    },
  });
  const body = `<h1>My surfaces</h1>
  <p style="color:var(--muted);font-size:14.5px;">Surfaces you own. Surfaces created by claimed agents on your behalf appear here.</p>
  <div class="card">
    ${
      surfaces.length === 0
        ? `<p class="empty">No surfaces yet. Once one of your agents creates one, it'll show up here.</p>`
        : `<ul class="list">${surfaces
            .map((s) => {
              const isActive =
                s.status === "open" && s.expiresAt.getTime() > Date.now();
              const statusBadge = isActive
                ? `<span class="pill good">Active</span>`
                : `<span class="pill muted">Closed</span>`;
              // Open is an actual link to the cookie-authed owner shell
              // (/surfaces/:id) — distinct from the share-link path
              // (/s/:token). No participant token in the URL; the pane_login
              // cookie does the auth, so a stolen URL is inert.
              const openAction = isActive
                ? `<a class="btn ghost" href="/surfaces/${encodeURIComponent(s.id)}" style="padding:6px 12px;font-size:13px;">Open</a>`
                : "";
              return `<li><div><div class="title">${escapeHtml(s.title)}</div><div class="meta"><code>${escapeHtml(s.id)}</code> · created ${escapeHtml(s.createdAt.toISOString().slice(0, 10))}</div></div><div style="display:flex;gap:10px;align-items:center;">${statusBadge}${openAction}</div></li>`;
            })
            .join("")}</ul>`
    }
  </div>`;
  return c.html(
    layout({
      title: "My surfaces",
      email: human.email,
      body,
      active: "surfaces",
    }),
  );
});

// ----------------------------------------------------------------------
// GET /my-templates — list of templates owned by the human's agents
// ----------------------------------------------------------------------
systemPages.get("/my-templates", async (c) => {
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "My templates", email: null, body: loggedOutPrompt() }),
    );
  }
  const prisma = c.get("prisma");
  // Two lists side by side: templates the human's claimed agents own
  // (authored), and templates the human has installed from the public
  // catalog. Installed entries carry the #267 PR C blocked-upgrade
  // pill when an auto-advance was refused by the compat gate.
  const [templates, installs] = await Promise.all([
    prisma.template.findMany({
      where: { owner: { ownerHumanId: human.id } },
      orderBy: { lastUsedAt: { sort: "desc", nulls: "last" } },
      take: 50,
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        shape: true,
        publishedAt: true,
        createdAt: true,
      },
    }),
    prisma.humanTemplateInstall.findMany({
      where: { humanId: human.id, uninstalledAt: null },
      orderBy: { installedAt: "desc" },
      take: 50,
      include: {
        template: {
          select: {
            id: true,
            name: true,
            slug: true,
            latestVersion: true,
          },
        },
      },
    }),
  ]);
  const installedSection =
    installs.length === 0
      ? ""
      : `<h2 style="margin-top:24px;">Installed</h2>
  <div class="card">
    <ul class="list">${installs
      .map((i) => {
        const blockedPill = i.upgradeBlockedAt
          ? `<span class="pill" style="background:#fff4ec;color:#b34700;">Upgrade blocked</span>`
          : "";
        const policyPill =
          i.upgradePolicy === "follow"
            ? `<span class="pill muted">Follow</span>`
            : `<span class="pill muted">Pinned v${i.installedVersion}</span>`;
        const newerAvailable =
          i.template.latestVersion > i.installedVersion
            ? `<span class="pill" style="background:var(--accent-soft);color:var(--accent-ink);">v${i.template.latestVersion} available</span>`
            : "";
        const blockedNote = i.upgradeBlockedAt
          ? `<div class="meta" style="color:#b34700;margin-top:4px;">A new version of this template can't be applied automatically — its schema narrows yours. Visit the template author or upgrade with <code>compat: &quot;force&quot;</code>.</div>`
          : "";
        return `<li><div><div class="title">${escapeHtml(i.template.name ?? i.template.slug ?? i.template.id)}</div><div class="meta">installed v${i.installedVersion}</div>${blockedNote}</div><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${policyPill}${newerAvailable}${blockedPill}</div></li>`;
      })
      .join("")}</ul>
  </div>`;
  const body = `<h1>My templates</h1>
  <p style="color:var(--muted);font-size:14.5px;">Templates created by agents you own. Templates you've installed from the public catalog appear below.</p>
  <h2>Authored</h2>
  <div class="card">
    ${
      templates.length === 0
        ? `<p class="empty">No templates yet.</p>`
        : `<ul class="list">${templates
            .map(
              (t) =>
                `<li><div><div class="title">${escapeHtml(t.name ?? t.slug ?? t.id)}</div><div class="meta">${t.description ? escapeHtml(t.description) : "<em>no description</em>"} · ${escapeHtml(t.shape)}</div></div>${t.publishedAt ? `<span class="pill good">Published</span>` : `<span class="pill muted">Private</span>`}</li>`,
            )
            .join("")}</ul>`
    }
  </div>
  ${installedSection}`;
  return c.html(
    layout({
      title: "My templates",
      email: human.email,
      body,
      active: "templates",
    }),
  );
});

// ----------------------------------------------------------------------
// GET /my-agents — list of claimed agents
// ----------------------------------------------------------------------
systemPages.get("/my-agents", async (c) => {
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "My agents", email: null, body: loggedOutPrompt() }),
    );
  }
  const prisma = c.get("prisma");
  const agents = await prisma.agent.findMany({
    where: { ownerHumanId: human.id },
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
  const body = `<h1>My agents</h1>
  <p style="color:var(--muted);font-size:14.5px;">Agents bound to you via the claim flow. Each agent's API key still works after claim — claiming just records ownership.</p>
  <div class="card">
    <div class="row" style="justify-content:space-between;margin-bottom:6px;">
      <h2 style="margin:0;">Claim a new agent</h2>
      <button id="gen-code" class="btn">Generate claim code</button>
    </div>
    <p style="color:var(--muted);font-size:14px;margin:0 0 8px;">Generate a one-time code, then run <code>pane agent claim &lt;code&gt;</code> on the agent.</p>
    <div id="code-out" hidden style="background:var(--accent-soft);border:1px solid var(--accent-border);border-radius:10px;padding:14px 16px;">
      <div style="font-size:12px;color:var(--accent);font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">Your code</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <code id="code-value" style="font-size:15px;background:var(--panel);padding:6px 10px;display:inline-block;border-radius:6px;border:1px solid var(--accent-border);user-select:all;"></code>
        <button id="copy-code" type="button" class="btn ghost" style="padding:6px 12px;font-size:13px;min-height:36px;">Copy</button>
      </div>
      <div style="font-size:13px;color:var(--accent-ink);margin-top:8px;">Expires in <span id="code-ttl"></span>. Copy now — you won't see it again.</div>
    </div>
  </div>
  <div class="card">
    <h2 style="margin-top:0;">Claimed</h2>
    ${
      agents.length === 0
        ? `<p class="empty">No claimed agents yet.</p>`
        : `<ul class="list">${agents
            .map(
              (a) =>
                `<li><div><div class="title">${escapeHtml(a.name)}</div><div class="meta"><code>${escapeHtml(a.keyPrefix)}…</code> · claimed ${a.claimedAt ? escapeHtml(a.claimedAt.toISOString().slice(0, 10)) : "—"}</div></div>${a.revokedAt ? `<span class="pill muted">Revoked</span>` : `<span class="pill good">Active</span>`}</li>`,
            )
            .join("")}</ul>`
    }
  </div>
  <script>
    document.getElementById("gen-code")?.addEventListener("click", async (ev) => {
      const btn = ev.target;
      btn.disabled = true;
      btn.textContent = "Generating…";
      try {
        const res = await fetch("/v1/self/claim-codes", { method: "POST" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const body = await res.json();
        document.getElementById("code-value").textContent = body.code;
        const ttl = Math.max(0, Math.round((new Date(body.expires_at).getTime() - Date.now()) / 60000));
        document.getElementById("code-ttl").textContent = ttl + " min";
        document.getElementById("code-out").hidden = false;
      } catch (err) {
        alert("Failed to generate code: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Generate claim code";
      }
    });
    document.getElementById("copy-code")?.addEventListener("click", async (ev) => {
      const code = document.getElementById("code-value").textContent || "";
      if (!code) return;
      const btn = ev.target;
      const original = btn.textContent;
      let ok = false;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(code);
          ok = true;
        } else {
          // Fallback for non-secure contexts (e.g. http on mobile).
          const ta = document.createElement("textarea");
          ta.value = code;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.top = "0";
          ta.style.left = "0";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand("copy");
          document.body.removeChild(ta);
        }
      } catch {
        ok = false;
      }
      btn.textContent = ok ? "Copied!" : "Copy failed";
      setTimeout(() => { btn.textContent = original; }, 1500);
    });
  </script>`;
  return c.html(
    layout({
      title: "My agents",
      email: human.email,
      body,
      active: "agents",
    }),
  );
});

// ----------------------------------------------------------------------
// GET /settings — email, sign-out
// ----------------------------------------------------------------------
systemPages.get("/settings", (c) => {
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "Settings", email: null, body: loggedOutPrompt() }),
    );
  }
  const verified = human.verifiedAt
    ? `<span class="pill good">Verified</span>`
    : `<span class="pill muted">Unverified</span>`;
  const body = `<h1>Settings</h1>
  <div class="card">
    <h2 style="margin-top:0;">Account</h2>
    <ul class="list">
      <li><div><div class="title">Email</div><div class="meta">${escapeHtml(human.email)}</div></div>${verified}</li>
      <li><div><div class="title">Account created</div><div class="meta">${escapeHtml(human.createdAt.toISOString().slice(0, 10))}</div></div></li>
    </ul>
  </div>
  <div class="card">
    <h2 style="margin-top:0;">Session</h2>
    <p style="color:var(--muted);font-size:14px;">Signing out will revoke this device's login. You can sign back in any time at <a href="/login">/login</a>.</p>
    <button id="pane-logout-btn" class="btn ghost">Sign out of this device</button>
  </div>
  <script>
    document.getElementById("pane-logout-btn")?.addEventListener("click", async () => {
      try { await fetch("/v1/auth/logout", { method: "POST" }); } catch {}
      location.href = "/login";
    });
  </script>`;
  return c.html(
    layout({
      title: "Settings",
      email: human.email,
      body,
      active: "settings",
    }),
  );
});

export default systemPages;
