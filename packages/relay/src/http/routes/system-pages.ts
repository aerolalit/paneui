// System pages — the bootstrap UI for a logged-in human.
//
//   GET  /login              static login form (email entry)
//   GET  /home               home page: favourites + links to other system pages
//   GET  /my-panes        list of panes the human participates on
//   GET  /my-templates       list of templates the human owns
//   GET  /my-agents          list of claimed agents + claim-new button
//   GET  /settings           email, home pick, logout
//
// Trust model: these pages are pane-shipped HTML (full-trust, same-origin
// fetches), NOT sandboxed iframes like agent templates. They use the
// Login cookie directly via window.fetch to /v1/self/* and /v1/agents/*.
//
// Architectural note: §5.2 says the home should be a TEMPLATE in DB
// (Pane row + Template row). For Phase D MVP these are direct HTML
// routes; templatising them is a follow-up refactor that doesn't change
// behaviour. See HUMAN-SIDE-PROPOSAL.md "Open decisions" tail.

import { Hono } from "hono";
import {
  resolveHumanOptional,
  type OptionalHumanAuthEnv,
} from "../../auth/human-auth.js";
import { BRAND_LOGO, BRAND_FAVICON_SVG } from "../../brand.js";
import { renderOwnerShell } from "./owner-shell-spa.js";
import { NAV_GLYPHS, NAV_LABELS, type NavKey } from "./nav-meta.js";

const systemPages = new Hono<OptionalHumanAuthEnv>();

systemPages.use("*", resolveHumanOptional);

// Shared layout primitives — every system page wraps its body in this
// shell so the visual identity is uniform.
//
// Mobile: the page is mobile-first. The header splits into two rows — a brand
// bar and a horizontally scrollable tab strip — so the nav never overflows or
// wraps awkwardly on a phone. A `prefers-color-scheme: dark` block maps the
// palette onto the same navy the pane shell uses.
// Tab icons used by both the top tab bar (desktop) and the bottom tab bar
// (mobile). The glyph geometry is the shared source of truth (NAV_GLYPHS in
// nav-meta.ts) so these match the owner-shell SPA exactly; here we only wrap
// each glyph in the legacy `.tab-ico` <svg> (sized via CSS to currentColor).
// The nav slugs map onto canonical NavKeys (catalog -> store). There is no
// `trash` entry — that tab was retired (the /trash route now redirects home).
// stroke-width 2 matches the SPA's spaIco wrapper (owner-shell-spa.ts) so the
// nav icons render identically on the system pages and the /home SPA.
const tabIco = (key: NavKey): string =>
  `<svg class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_GLYPHS[key]}</svg>`;
const TAB_ICONS: Record<string, string> = {
  home: tabIco("home"),
  catalog: tabIco("store"),
  panes: tabIco("panes"),
  templates: tabIco("templates"),
  agents: tabIco("agents"),
  settings: tabIco("settings"),
};

function layout(args: {
  title: string;
  email: string | null;
  body: string;
  /** Slug of the current page (e.g. "home"). Highlights the nav link. */
  active?: string;
}): string {
  const nav = (slug: string, label: string, href: string) => {
    const cls = args.active === slug ? "tab active" : "tab";
    const ariaCurrent = args.active === slug ? ' aria-current="page"' : "";
    const ico = TAB_ICONS[slug] ?? "";
    return `<a class="${cls}" href="${href}"${ariaCurrent}>${ico}<span class="tab-label">${escapeHtml(label)}</span></a>`;
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
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="pane" />
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
  header.pane-nav .brand svg { display: block; }
  header.pane-nav .brand .wordmark {
    font-weight: 700; font-size: 16px; letter-spacing: -0.02em;
    background: linear-gradient(135deg, #93c5fd 0%, #c4b5fd 60%, #5eead4 110%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  header.pane-nav .account { display: flex; align-items: center; gap: 10px; margin-left: auto; min-width: 0; }
  .acct-email { font-size: 13px; color: var(--muted); max-width: 36vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acct-signout { background: transparent; border: 1px solid var(--rule); color: var(--muted); font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 8px; cursor: pointer; flex: none; }
  .acct-signout:hover { border-color: var(--accent); color: var(--accent); }
  .acct-signin { color: var(--accent); font-size: 14px; font-weight: 600; text-decoration: none; }

  /* Tab bar — two presentations driven by viewport width:
       Desktop (>=640px): a top tab strip inside the sticky header.
       Mobile  (<640px): a fixed bottom tab bar (iOS / Android pattern)
                          with stacked icon + label. The top tab strip
                          hides on mobile via the @media block below.
     The same .tabs container + .tab anchor markup feeds both — only the
     wrapping element's position and the .tab's flex direction change. */
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
    display: inline-flex; align-items: center; gap: 6px;
  }
  .tab:hover { color: var(--fg); }
  .tab.active { color: var(--accent); font-weight: 600; border-bottom-color: var(--accent); }
  /* The header's tab strip hides the icon (text-only) on desktop. The
     bottom-bar mobile presentation flips this — icon shown, label small. */
  header.pane-nav .tab .tab-ico { width: 0; height: 0; display: none; }

  /* The dedicated bottom bar is rendered alongside the header strip and
     promoted to display:flex on narrow viewports below. Keeping the markup
     always present (rather than conditionally serving it) avoids a layout
     flash if the viewport rotates between renders. */
  nav.bottom-tabs {
    display: none;
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
    background: color-mix(in srgb, var(--panel) 92%, transparent);
    -webkit-backdrop-filter: saturate(180%) blur(14px);
    backdrop-filter: saturate(180%) blur(14px);
    border-top: 1px solid var(--rule);
    padding: 6px max(8px, env(safe-area-inset-left)) calc(6px + env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-right));
  }
  nav.bottom-tabs .tabs {
    max-width: 720px; margin: 0 auto;
    display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
    gap: 0; overflow: visible;
  }
  nav.bottom-tabs .tab {
    flex-direction: column; gap: 3px;
    padding: 8px 4px 4px; border-bottom: none;
    font-size: 11px; line-height: 1.1; min-height: 52px;
    border-radius: 8px;
    text-align: center; justify-content: center;
  }
  nav.bottom-tabs .tab .tab-ico { display: block; width: 22px; height: 22px; }
  nav.bottom-tabs .tab.active { background: transparent; border-bottom: none; }
  nav.bottom-tabs .tab .tab-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

  /* Mobile-only: hide the header tab strip, show the bottom bar, reserve
     space at the foot of main so content can't slide under the bar. */
  @media (max-width: 639px) {
    header.pane-nav nav.tabs { display: none; }
    nav.bottom-tabs { display: block; }
  }

  main { max-width: 920px; margin: 0 auto; padding: 24px 16px calc(80px + env(safe-area-inset-bottom)); }
  @media (max-width: 639px) {
    /* Add the bottom-bar's height (~64px including safe-area) so the last
       row of cards isn't hidden behind it. */
    main { padding-bottom: calc(96px + env(safe-area-inset-bottom)); }
  }
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
  /* First-touch empty state — icon + headline + one sentence + one CTA.
     Used wherever the primary list of a logged-in page is empty. The plain
     .empty rule above survives for the second-tier "no results" case
     (search miss / minor lists). */
  .empty-state { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 36px 18px 30px; text-align: center; }
  .empty-state-icon { color: var(--muted); width: 38px; height: 38px; flex: none; }
  .empty-state-headline { margin: 4px 0 0; font-size: 16.5px; font-weight: 600; color: var(--fg); }
  .empty-state-body { margin: 0; max-width: 380px; color: var(--muted); font-size: 14px; line-height: 1.55; }
  .empty-state-body code { font-size: 12.5px; user-select: all; }
  .empty-state-cta { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .empty-state-snippet { font-family: "SF Mono",Menlo,Consolas,monospace; background: var(--code-bg); padding: 8px 12px; border-radius: 6px; font-size: 13px; user-select: all; margin-top: 4px; display: inline-block; }

  /* Login landing — two-column on wide viewports (hero + form), stacked on
     narrow ones. Anything inside the .login-* tree only fires on the
     dedicated /login page; the same layout shell still serves the other
     pages with a single .card block. */
  .login-grid { display: grid; gap: 32px; margin: 32px auto 0; max-width: 920px; }
  @media (min-width: 880px) {
    .login-grid { grid-template-columns: 1.1fr 1fr; gap: 56px; align-items: start; }
  }
  .login-hero-title { margin: 0 0 14px; font-size: 30px; line-height: 1.15; letter-spacing: -0.02em; }
  @media (min-width: 880px) { .login-hero-title { font-size: 36px; } }
  .login-hero-lede { margin: 0 0 14px; color: var(--muted); font-size: 15.5px; line-height: 1.55; }
  .login-hero-lede em { color: var(--fg); font-style: normal; font-weight: 600; }
  .login-form-card { margin: 0; max-width: 420px; align-self: start; }
  @media (max-width: 879px) { .login-form-card { margin: 0 auto; } }

  /* Mock artifact preview — a CSS-rendered representation of what a Pane
     pane looks like in the wild. Static; aria-hidden so screen readers
     skip it. The look mirrors the bridge's iframe shell (chrome bar,
     preamble band, content) so the lede + preview cohere. */
  .hero-mock { margin-top: 24px; border: 1px solid var(--rule); border-radius: 14px; overflow: hidden; background: var(--panel); box-shadow: var(--shadow); }
  .hero-mock-chrome { display: flex; gap: 6px; align-items: center; padding: 10px 14px; background: var(--code-bg); border-bottom: 1px solid var(--rule); }
  .hero-mock-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--rule); flex: none; }
  .hero-mock-url { margin-left: 10px; color: var(--muted); font-size: 12.5px; font-family: "SF Mono",Menlo,Consolas,monospace; }
  .hero-mock-preamble { padding: 9px 14px; background: var(--accent-soft); border-bottom: 1px solid var(--accent-border); color: var(--accent-ink); font-size: 13px; border-left: 3px solid var(--accent); }
  .hero-mock-body { padding: 16px 18px 18px; }
  .hero-mock-title { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
  .hero-mock-title code { font-size: 14px; }
  .hero-mock-meta { color: var(--muted); font-size: 13px; margin-bottom: 14px; }
  .hero-mock-buttons { display: flex; gap: 8px; }
  .hero-mock-btn { display: inline-flex; align-items: center; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--rule); background: var(--bg); color: var(--fg); font-size: 13px; font-weight: 500; }
  .hero-mock-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }

  /* Pane cards — /my-panes switched from a text list to one card
     per pane, with a hash-coloured tile (template initials) on the
     left so the eye can lock onto a particular pane at a glance.
     The .list rule above survives for the other pages that don't need
     this density. */
  /* Pane rows on /my-panes — tighter than the previous boxy card. The
     prototype at /tmp/owner-shell-v2.html uses a 44px tile + mono meta
     line + colored status pill, all sitting in a compact row. Same
     hue-gradient tile family as /home + /template-store so the eye
     locks onto the template across views. */
  .pane-cards { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .pane-card {
    display: grid;
    grid-template-columns: 44px 1fr auto;
    gap: 14px;
    align-items: center;
    padding: 12px 14px;
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 12px;
    transition: border-color .14s ease, transform .14s ease;
  }
  .pane-card:hover { border-color: hsl(var(--tile-h,260), 60%, 55%); transform: translateY(-1px); }
  .pane-card-tile {
    width: 44px; height: 44px;
    border-radius: 11px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 15px; letter-spacing: 0.04em;
    color: #07090f;
    background: linear-gradient(135deg, hsl(var(--tile-h,260), 80%, 70%) 0%, hsl(calc(var(--tile-h,260) + 30), 75%, 60%) 100%);
    box-shadow: 0 4px 12px rgba(0,0,0,.18), 0 1px 2px rgba(0,0,0,.12);
    flex: none; user-select: none;
  }
  .pane-card-main { min-width: 0; }
  .pane-card-title {
    font-weight: 600; font-size: 14.5px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pane-card-meta {
    font-size: 12px; color: var(--muted);
    font-family: "SF Mono", Menlo, Consolas, monospace;
    margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pane-card-meta-dim { color: var(--muted); }
  .pane-card-actions { display: flex; gap: 8px; align-items: center; flex-wrap: nowrap; justify-content: flex-end; }
  @media (max-width: 540px) {
    .pane-card { grid-template-columns: 44px 1fr; }
    .pane-card-actions { grid-column: 1 / -1; justify-content: flex-start; padding-top: 6px; }
    .pane-card-actions::before {
      content: ""; display: block; width: 100%; height: 1px;
      background: var(--rule); margin-bottom: 6px;
    }
  }

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
    ${nav("home", NAV_LABELS.home, "/home")}
    ${nav("panes", NAV_LABELS.panes, "/my-panes")}
    ${nav("catalog", NAV_LABELS.store, "/template-store")}
    ${nav("templates", NAV_LABELS.templates, "/my-templates")}
    ${nav("agents", NAV_LABELS.agents, "/my-agents")}
    ${nav("settings", NAV_LABELS.settings, "/settings")}
  </nav>
</header>
<main>
  ${args.body}
</main>
<nav class="bottom-tabs" aria-label="Primary (mobile)">
  <div class="tabs">
    ${nav("home", NAV_LABELS.home, "/home")}
    ${nav("panes", NAV_LABELS.panes, "/my-panes")}
    ${nav("catalog", NAV_LABELS.store, "/template-store")}
    ${nav("templates", NAV_LABELS.templates, "/my-templates")}
    ${nav("settings", NAV_LABELS.settings, "/settings")}
  </div>
</nav>
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

// Two-character "avatar" derived from the template name. Used as the
// colored tile on each /my-panes card so visually scanning a long list
// is faster than reading titles. Falls back to "?" for blank input.
export function paneInitials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  // Strip leading non-alphanumerics, then take the first two word-starts.
  const words = trimmed
    .split(/[\s_\-/.]+/)
    .filter((w) => /[A-Za-z0-9]/.test(w));
  if (words.length === 0) return trimmed.slice(0, 2).toUpperCase();
  if (words.length === 1) return (words[0] ?? "").slice(0, 2).toUpperCase();
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
}

// Stable hue in [0, 360) derived from the pane id. Each card gets a
// distinct background tile without having to track per-template color
// metadata in the DB; same pane always renders the same hue.
export function paneHue(seed: string): number {
  // djb2 — good enough for visual differentiation; no security claim.
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

// "today" / "yesterday" / "Nd ago" / ISO date. Keeps the meta line short
// without losing the "is this fresh or stale" signal. The plain ISO date
// stays for anything older than 14 days so the eye can compare exact dates
// when scrolling through a long backlog.
export function formatRelativeDate(when: Date, now: Date): string {
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(when.getFullYear(), when.getMonth(), when.getDate());
  const diffDays = Math.round((start.getTime() - target.getTime()) / day);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays > 1 && diffDays < 14) return `${diffDays}d ago`;
  return when.toISOString().slice(0, 10);
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
// GET /favicon.svg — the brand mark as a real asset. Same shape as the
// inline header logo + the data-URI favicon in bridge/routes.ts — all
// three derive from the single source in src/brand.ts so they cannot
// drift.
// ----------------------------------------------------------------------
systemPages.get("/favicon.svg", (c) => {
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(BRAND_FAVICON_SVG);
});

// ----------------------------------------------------------------------
// GET /manifest.webmanifest — PWA manifest.
//
// Served from the relay so an installed-to-homescreen pane (Add to Home
// Screen on iOS, Install on Android/Chrome) launches into /home as a
// standalone app — no browser chrome. Inlined: short, no asset pipeline,
// and the file rarely changes.
// ----------------------------------------------------------------------
systemPages.get("/manifest.webmanifest", (c) => {
  c.header("Content-Type", "application/manifest+json");
  // Long cache — the manifest's contents change infrequently; the routes
  // themselves are the source of truth. A bump in this string forces
  // installed PWAs to re-fetch via the next session.
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(
    JSON.stringify({
      name: "pane",
      short_name: "pane",
      description: "Round-trip UI channel between agents and humans",
      start_url: "/home",
      scope: "/",
      display: "standalone",
      orientation: "any",
      background_color: "#0b0e14",
      theme_color: "#0b0e14",
      categories: ["productivity", "developer"],
      // Icons inlined as a single SVG. Real-world PWAs typically ship
      // PNG variants too; iOS still respects the apple-touch-icon meta
      // even when the manifest only declares SVG, so this is sufficient
      // for the install flow without standing up an asset pipeline.
      icons: [
        {
          src: "/favicon.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any",
        },
      ],
    }),
  );
});

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
      <p style="color:var(--muted);font-size:15px;margin:0 0 18px;">A round-trip UI channel between agents and humans. An agent renders an HTML pane, the relay hands a human the URL, the human's interactions come back to the agent as structured events.</p>
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
        <p>This relay is configured with <code>EMAIL_PROVIDER=none</code>; only the agent API and capability-URL panes are available.</p>
        <p>If you're operating this relay, configure an email provider (Azure, SMTP, or Resend) and restart.</p>
       </div>`
    : `<div class="login-grid">
        <section class="login-hero">
          <h1 class="login-hero-title">A real UI for the human in the loop.</h1>
          <p class="login-hero-lede">Pane is a round-trip UI channel between your agents and you: an agent renders an HTML form, dashboard, or report; you get a URL; your interactions stream back to the agent as structured events.</p>
          <p class="login-hero-lede">Close the loop without building a custom frontend — for deploy approvals, PR reviews, surveys, dashboards, anything the human needs to <em>see and act on</em>.</p>
          <div class="hero-mock" aria-hidden="true">
            <div class="hero-mock-chrome">
              <span class="hero-mock-dot"></span>
              <span class="hero-mock-dot"></span>
              <span class="hero-mock-dot"></span>
              <span class="hero-mock-url">pane → ci-bot</span>
            </div>
            <div class="hero-mock-preamble">Your CI bot wants you to approve a deploy.</div>
            <div class="hero-mock-body">
              <div class="hero-mock-title">Approve deploy to <code>prod</code>?</div>
              <div class="hero-mock-meta">Service: api · Build #1138 · Diff +124 −37</div>
              <div class="hero-mock-buttons">
                <span class="hero-mock-btn primary">Approve</span>
                <span class="hero-mock-btn">Reject</span>
              </div>
            </div>
          </div>
        </section>
        <section class="login-form-card card">
          <h2 style="margin-top:0;">Sign in</h2>
          <p style="color:var(--muted);font-size:14.5px;">We'll email you a one-time sign-in link. No password.</p>
          <form id="login-form" autocomplete="on">
            <label for="name" style="font-size:13px;color:var(--muted);margin-bottom:6px;display:block;margin-top:0;">Your name <span style="color:var(--muted);font-weight:400;">— optional, shown on /home</span></label>
            <input id="name" name="name" type="text" autocomplete="name" placeholder="e.g. Alice" maxlength="80" style="margin-bottom:12px;" />
            <label for="email" style="font-size:13px;color:var(--muted);margin-bottom:6px;display:block;">Email</label>
            <input id="email" name="email" type="email" required autofocus autocomplete="email" />
            <button class="btn" type="submit" style="width:100%;margin-top:14px;">Email me a link</button>
          </form>
          <p id="login-status" style="margin-top:14px;font-size:14px;color:var(--muted);" aria-live="polite"></p>
          <p style="margin-top:18px;font-size:13px;color:var(--muted);">New here? Sign-in creates your account on first use — there's nothing to set up first.</p>
        </section>
       </div>
       <script>
         const form = document.getElementById("login-form");
         const status = document.getElementById("login-status");
         form?.addEventListener("submit", async (e) => {
           e.preventDefault();
           const email = (document.getElementById("email")).value.trim();
           const name = (document.getElementById("name")).value.trim();
           if (!email) return;
           status.textContent = "Sending…";
           try {
             const body = { email };
             if (name.length > 0) body.name = name;
             const res = await fetch("/v1/auth/request-link", {
               method: "POST",
               headers: { "content-type": "application/json" },
               body: JSON.stringify(body),
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
// GET /home — Launchpad-style home view (close-to-prototype rewrite).
//
// Faithful to /tmp/owner-shell-v2.html's "home" view:
//
//   1. Gradient greeting "Hey, <name>" + stats subline. The name has the
//      brand-gradient text treatment so the eye catches it first.
//   2. Search bar (placeholder only this iteration — full search is a
//      separate piece of work; the bar anchors the visual layout).
//   3. Favourites — a horizontal-scroll strip of 76×76 gradient tiles,
//      one per installed template. Tap = one-tap pane launch via the
//      existing /v1/my-templates/:id/launch route.
//   4. Open panes — a horizontal-scroll card strip with a colored thumb
//      + tag, title, and relative date. Mirrors the prototype's
//      .recent-card.
//   5. All templates — a Launchpad-style grid of 64×64 gradient tiles
//      drawn from every install + every template owned by one of the
//      human's claimed agents.
//
// Keeps the existing top-tab/bottom-tab nav chrome. Replacing the chrome
// with the prototype's persistent sidebar is a larger follow-up refactor.
// ----------------------------------------------------------------------

systemPages.get("/home", async (c) => {
  // Authenticated, per-human HTML that inlines the owner CSS/JS — never cache
  // it, or a UI deploy stays invisible behind a stale browser/PWA copy.
  c.header("Cache-Control", "private, no-store");
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "Home", email: null, body: loggedOutPrompt() }),
    );
  }
  const prisma = c.get("prisma");
  const html = await renderOwnerShell({ prisma, human });
  return c.html(html);
});

// ----------------------------------------------------------------------
// GET /my-panes — list of panes the human owns
// ----------------------------------------------------------------------
systemPages.get("/my-panes", (c) => c.redirect("/home#panes", 301));

// ----------------------------------------------------------------------
// GET /my-templates — list of templates owned by the human's agents
// ----------------------------------------------------------------------
systemPages.get("/my-templates", (c) => c.redirect("/home#mine", 301));

// ----------------------------------------------------------------------
// GET /my-templates/:id/content — template-records management view.
//
// Owner-only (the calling human must own the template's agent). Lists
// every collection declared in the template's latest version's
// templateRecordSchema, with the existing rows + an "Add row" form per
// collection. Writes go through /v1/my-templates/:id/template-records/:c
// (cookie-authed, defined in template-marketplace.ts) and the page
// refreshes its row list inline on success.
//
// This is the publisher-side surface for curating shared content that
// every pane derived from the template sees in real time. The data path
// is: write here → relay broadcasts template-record.* on every derived
// pane's WS → page-side bridge fires pane.template.records.on handlers
// in each iframe.
// ----------------------------------------------------------------------
systemPages.get("/my-templates/:id/content", async (c) => {
  // no-store: authenticated, CSS-inlining HTML must not be cached (see /home).
  c.header("Cache-Control", "private, no-store");
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({
        title: "Template content",
        email: null,
        body: loggedOutPrompt(),
      }),
    );
  }
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  const template = await prisma.template.findUnique({
    where: { id },
    include: { owner: { select: { ownerHumanId: true } } },
  });
  // 404 (not 401/403) on miss or not-owned — same shape as the existing
  // owner-only routes; never confirms the existence of someone else's
  // template to the caller.
  if (!template || template.owner.ownerHumanId !== human.id) {
    return c.html(
      layout({
        title: "Template content",
        email: human.email,
        body: `<div class="card"><h1>Template not found</h1><p>This template does not exist or is not yours. <a href="/my-templates">Back to My templates</a>.</p></div>`,
        active: "templates",
      }),
      404,
    );
  }
  const version = await prisma.templateVersion.findUnique({
    where: {
      templateId_version: {
        templateId: template.id,
        version: template.latestVersion,
      },
    },
    select: { templateRecordSchema: true, version: true },
  });
  const tplSchema = (version?.templateRecordSchema ?? null) as Record<
    string,
    unknown
  > | null;
  const xpc = (tplSchema?.["x-pane-collections"] ?? null) as Record<
    string,
    unknown
  > | null;
  const collections: string[] = xpc ? Object.keys(xpc) : [];
  // Human-visible page heading; legacy inline templates have name+slug null,
  // so fall back to a readable label rather than the raw cuid id.
  const name = template.name ?? template.slug ?? "Untitled template";
  const subtitle = `v${version?.version ?? template.latestVersion} · ${collections.length === 0 ? "no template-level collections declared" : `${collections.length} collection${collections.length === 1 ? "" : "s"}`}`;

  // Render shell HTML; the row lists hydrate client-side from
  // /v1/my-templates/:id/template-records/:collection so a fresh write
  // (or a delete) can refresh without a full reload.
  let body = `<p style="margin:0 0 4px;"><a href="/my-templates" style="font-size:13px;">← My templates</a></p>
  <h1>${escapeHtml(name)} · content</h1>
  <p style="color:var(--muted);font-size:14px;margin:0 0 18px;">${escapeHtml(subtitle)}</p>`;

  if (collections.length === 0) {
    body += `<div class="card empty-state">
      <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h13l3 3v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 11h8M8 15h5"/></svg>
      <h3 class="empty-state-headline">No template-level collections declared</h3>
      <p class="empty-state-body">This template doesn't carry a <code>template_record_schema</code>. Add one when publishing a new version to make shared content available — derived panes will see updates live through <code>pane.template.records</code>.</p>
    </div>`;
  } else {
    for (const collection of collections) {
      // Each collection block: heading + add-form + an empty &lt;ul&gt;
      // that the client populates on load. Keys are CSS-escaped via
      // [data-collection="..."] selectors so collection names with hyphens
      // stay safe.
      body += `<section class="card" data-collection="${escapeHtml(collection)}">
        <h2 style="margin:0 0 12px;font-size:16px;letter-spacing:-0.005em;">${escapeHtml(collection)}</h2>
        <form class="trec-add" data-collection="${escapeHtml(collection)}" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
          <input class="trec-key" type="text" placeholder="record key (optional)" style="flex:0 1 180px;min-width:140px;" />
          <input class="trec-data" type="text" placeholder='data JSON, e.g. {"text":"Hello"}' required style="flex:1 1 240px;min-width:200px;font-family:&quot;SF Mono&quot;,Menlo,Consolas,monospace;font-size:13px;" />
          <button class="btn" type="submit">Add</button>
        </form>
        <ul class="list trec-rows" data-collection="${escapeHtml(collection)}"><li class="empty">Loading…</li></ul>
      </section>`;
    }

    body += `<script>
      // Client-side hydration. Each collection block has a UL the script
      // populates via GET /v1/my-templates/:id/template-records/:collection.
      // Mutations (add / delete) hit the matching POST / DELETE under the
      // same prefix and re-render the affected list on success.
      const TEMPLATE_ID = ${JSON.stringify(template.id)};

      function escape(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      async function loadCollection(name) {
        const ul = document.querySelector(\`ul.trec-rows[data-collection="\${CSS.escape(name)}"]\`);
        if (!ul) return;
        ul.innerHTML = '<li class="empty">Loading…</li>';
        try {
          const res = await fetch(
            \`/v1/my-templates/\${encodeURIComponent(TEMPLATE_ID)}/template-records/\${encodeURIComponent(name)}?since=0\`,
            { credentials: 'same-origin' },
          );
          if (!res.ok) {
            ul.innerHTML = '<li class="empty">Failed to load (' + res.status + ')</li>';
            return;
          }
          const body = await res.json();
          const live = (body.records || []).filter((r) => r.deleted_at === null);
          if (!live.length) {
            ul.innerHTML = '<li class="empty">No rows yet — add one above.</li>';
            return;
          }
          ul.innerHTML = live.map((r) => {
            const dataStr = JSON.stringify(r.data);
            return '<li data-key="' + escape(r.key) + '">'
              + '<div><div class="title">' + escape(r.key) + '</div>'
              + '<div class="meta"><code>' + escape(dataStr) + '</code></div>'
              + '<div class="meta meta-dim" style="color:var(--muted);">v' + escape(r.version) + ' · ' + escape(r.author.kind) + '</div></div>'
              + '<div><button class="btn ghost trec-delete" data-key="' + escape(r.key) + '" data-version="' + escape(r.version) + '">Delete</button></div>'
              + '</li>';
          }).join('');
        } catch (e) {
          ul.innerHTML = '<li class="empty">Network error</li>';
        }
      }

      // Initial load for every declared collection.
      for (const sec of document.querySelectorAll('section[data-collection]')) {
        loadCollection(sec.getAttribute('data-collection'));
      }

      // Add-row form submit → POST.
      document.body.addEventListener('submit', async (ev) => {
        const form = ev.target;
        if (!(form instanceof HTMLElement) || !form.classList.contains('trec-add')) return;
        ev.preventDefault();
        const name = form.getAttribute('data-collection');
        const keyEl = form.querySelector('.trec-key');
        const dataEl = form.querySelector('.trec-data');
        const key = (keyEl && keyEl.value || '').trim();
        const raw = (dataEl && dataEl.value || '').trim();
        let data;
        try { data = JSON.parse(raw); }
        catch { alert('Data must be valid JSON.'); return; }
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Adding…';
        try {
          const body = { data };
          if (key.length > 0) body.record_key = key;
          const res = await fetch(
            \`/v1/my-templates/\${encodeURIComponent(TEMPLATE_ID)}/template-records/\${encodeURIComponent(name)}\`,
            { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) },
          );
          if (!res.ok && res.status !== 200 && res.status !== 201) {
            const err = await res.json().catch(() => ({}));
            alert('Add failed: ' + (err.error && err.error.message || ('HTTP ' + res.status)));
            btn.disabled = false; btn.textContent = 'Add';
            return;
          }
          dataEl.value = ''; if (keyEl) keyEl.value = '';
          btn.disabled = false; btn.textContent = 'Add';
          loadCollection(name);
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Add';
          alert('Network error');
        }
      });

      // Delete-button click → DELETE.
      document.body.addEventListener('click', async (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest('button.trec-delete');
        if (!btn) return;
        const li = btn.closest('li[data-key]');
        const section = btn.closest('section[data-collection]');
        if (!li || !section) return;
        const name = section.getAttribute('data-collection');
        const key = li.getAttribute('data-key');
        if (!confirm('Delete row "' + key + '"?')) return;
        btn.disabled = true;
        try {
          const res = await fetch(
            \`/v1/my-templates/\${encodeURIComponent(TEMPLATE_ID)}/template-records/\${encodeURIComponent(name)}/\${encodeURIComponent(key)}\`,
            { method: 'DELETE', credentials: 'same-origin' },
          );
          if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            alert('Delete failed: ' + (err.error && err.error.message || ('HTTP ' + res.status)));
            btn.disabled = false;
            return;
          }
          loadCollection(name);
        } catch (e) {
          btn.disabled = false;
          alert('Network error');
        }
      });
    </script>`;
  }

  return c.html(
    layout({
      title: name + " · content",
      email: human.email,
      body,
      active: "templates",
    }),
  );
});

// ----------------------------------------------------------------------
// GET /template-store — public catalog browse page (#279).
// Human-facing wrapper over GET /v1/templates/public + install/uninstall.
//
// URL history: page started at `/apps`, renamed to `/public-templates`,
// now `/template-store` — leans into the install-from-a-catalog metaphor
// (parallel to App Store / Play Store). Both legacy paths 301 here so
// old links + bookmarks still resolve.
// ----------------------------------------------------------------------
systemPages.get("/apps", (c) => c.redirect("/home#mine", 301));
systemPages.get("/public-templates", (c) => c.redirect("/home#store", 301));

systemPages.get("/template-store", (c) => c.redirect("/home#store", 301));

// ----------------------------------------------------------------------
// GET /my-agents — list of claimed agents
// ----------------------------------------------------------------------
systemPages.get("/my-agents", async (c) => {
  // no-store: authenticated, CSS-inlining HTML must not be cached (see /home).
  c.header("Cache-Control", "private, no-store");
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "My agents", email: null, body: loggedOutPrompt() }),
    );
  }
  const prisma = c.get("prisma");
  // #305 — soft-deleted agents live on /trash by default. A revoked agent
  // (revokedAt != null) is still surfaced here with a "Revoked" pill, since
  // revocation and trash are distinct lifecycle states.
  // #310 — ?show_deleted=true opts trashed agents back into the view.
  const showDeleted = c.req.query("show_deleted") === "true";
  const agents = await prisma.agent.findMany({
    where: {
      ownerHumanId: human.id,
      ...(showDeleted ? {} : { deletedAt: null }),
    },
    orderBy: { claimedAt: { sort: "desc", nulls: "last" } },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      claimedAt: true,
      lastUsedAt: true,
      revokedAt: true,
      deletedAt: true,
    },
  });
  const agentsToggleLink = showDeleted
    ? `<a class="btn ghost" href="/my-agents" style="padding:6px 14px;font-size:13px;">Hide trashed</a>`
    : `<a class="btn ghost" href="/my-agents?show_deleted=true" style="padding:6px 14px;font-size:13px;">Show trashed</a>`;
  const body = `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <h1 style="margin:0;">My agents</h1>
    ${agentsToggleLink}
  </div>
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
        ? `<div class="empty-state">
          <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V5"/><circle cx="12" cy="3.6" r="1.4"/><circle cx="9" cy="13" r=".8" fill="currentColor"/><circle cx="15" cy="13" r=".8" fill="currentColor"/></svg>
          <h3 class="empty-state-headline">No claimed agents yet</h3>
          <p class="empty-state-body">Use the Generate claim code button above, then run <code>pane agent claim &lt;code&gt;</code> on the agent's machine. Each claim binds an existing agent key to your account — it doesn't replace the key.</p>
        </div>`
        : `<ul class="list">${agents
            .map((a) => {
              const lastUsed = a.lastUsedAt
                ? formatRelativeDate(a.lastUsedAt, new Date())
                : "never";
              const claimed = a.claimedAt
                ? escapeHtml(a.claimedAt.toISOString().slice(0, 10))
                : "—";
              const isTrashed = a.deletedAt !== null;
              const status = isTrashed
                ? `<span class="pill" style="background:#fff4ec;color:#b34700;">Trashed</span>`
                : a.revokedAt
                  ? `<span class="pill muted">Revoked</span>`
                  : `<span class="pill good">Active</span>`;
              // Rotation is only meaningful for non-revoked, non-trashed
              // agents; hide the button on either so the human can't mint a
              // key for an inert identity.
              const rotateBtn =
                a.revokedAt || isTrashed
                  ? ""
                  : `<button class="btn ghost" type="button" data-act="rotate" data-id="${escapeHtml(a.id)}" data-name="${escapeHtml(a.name)}" style="padding:6px 12px;font-size:13px;min-height:36px;">Regenerate key</button>`;
              return `<li data-agent-id="${escapeHtml(a.id)}">
                <div style="min-width:0;flex:1;">
                  <div class="title">${escapeHtml(a.name)}</div>
                  <div class="meta"><code>${escapeHtml(a.keyPrefix)}…</code> · claimed ${claimed} · last used ${escapeHtml(lastUsed)}</div>
                  <div class="rotate-out" hidden style="margin-top:10px;background:var(--accent-soft);border:1px solid var(--accent-border);border-radius:10px;padding:12px 14px;">
                    <div style="font-size:12px;color:var(--accent);font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">New API key</div>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                      <code class="rotate-value" style="font-size:14px;background:var(--panel);padding:6px 10px;display:inline-block;border-radius:6px;border:1px solid var(--accent-border);user-select:all;word-break:break-all;"></code>
                      <button class="btn ghost rotate-copy" type="button" style="padding:6px 12px;font-size:13px;min-height:36px;">Copy</button>
                    </div>
                    <div style="font-size:13px;color:var(--accent-ink);margin-top:8px;">Won't be shown again. Copy now and run <code>pane agent set-key &lt;key&gt;</code> on the agent's machine (or paste into <code>PANE_API_KEY</code>).</div>
                  </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${status}${rotateBtn}</div>
              </li>`;
            })
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

    // Regenerate-key handler — same disclosure pattern as the claim-code
    // generator: POST returns the raw key once, we reveal it inline and
    // hide the rotate button so the human can't accidentally double-rotate
    // before they've copied the first key out.
    document.addEventListener("click", async (ev) => {
      const btn = ev.target.closest && ev.target.closest("button[data-act='rotate']");
      if (!btn) return;
      const id = btn.getAttribute("data-id");
      const name = btn.getAttribute("data-name") || "this agent";
      if (!confirm(
        "Regenerate the API key for " + name + "?\\n\\n" +
        "The current key will stop working immediately. You'll see the new key once."
      )) return;
      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = "Regenerating…";
      try {
        const res = await fetch("/v1/self/agents/" + encodeURIComponent(id) + "/rotate-key", {
          method: "POST",
          credentials: "same-origin",
        });
        if (!res.ok) {
          let detail = "HTTP " + res.status;
          try {
            const errBody = await res.json();
            if (errBody && errBody.error && errBody.error.message) detail = errBody.error.message;
          } catch (_) {}
          alert("Couldn't regenerate key: " + detail);
          btn.disabled = false;
          btn.textContent = originalLabel;
          return;
        }
        const body = await res.json();
        const li = btn.closest("li[data-agent-id]");
        const reveal = li.querySelector(".rotate-out");
        li.querySelector(".rotate-value").textContent = body.api_key;
        reveal.hidden = false;
        // Hide the rotate button so the human focuses on copying.
        btn.remove();
      } catch (_) {
        alert("Network error — try again.");
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });

    // Copy-to-clipboard for the revealed new key. Same approach as the
    // claim-code copy button.
    document.addEventListener("click", async (ev) => {
      const btn = ev.target.closest && ev.target.closest("button.rotate-copy");
      if (!btn) return;
      const li = btn.closest("li[data-agent-id]");
      const code = (li.querySelector(".rotate-value") || {}).textContent || "";
      if (!code) return;
      const original = btn.textContent;
      let ok = false;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(code);
          ok = true;
        } else {
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
// GET /trash — soft-deleted panes + templates, with restore + purge.
// ----------------------------------------------------------------------
//
// #309 — Renders the human's trash. The HTML is server-rendered (lists
// from prisma), the row-level Restore + Purge buttons fire client-side
// fetches against /v1/my-trash/* (#309's cookie-authed routes). On
// success the row is removed from the DOM; on failure we surface the
// error code/message inline so the user knows what to do (the most
// common refusal is `409 conflict` on a template purge when a live pane
// still references it).
//
// Why the data is loaded server-side: a logged-in /trash visit should
// show the list immediately, not flash an empty state then a list. The
// mutations are still cookie-authed JSON so an accidental F5 doesn't
// double-fire.
// Trash no longer has a tab in the SPA — old links land on Home; the
// SPA's hash-router silently remaps "#trash" too. Auto-purge handles
// soft-deleted rows in the background.
systemPages.get("/trash", (c) => c.redirect("/home", 301));

// ----------------------------------------------------------------------
// GET /settings — now a view inside the /home SPA (#settings). Redirect the
// standalone URL in, the same way /my-panes, /my-templates, /template-store
// already fold into the single-page app. One nav/layout/CSS everywhere.
// ----------------------------------------------------------------------
systemPages.get("/settings", (c) => c.redirect("/home#settings", 301));

export default systemPages;
