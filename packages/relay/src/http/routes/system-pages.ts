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

const systemPages = new Hono<OptionalHumanAuthEnv>();

systemPages.use("*", resolveHumanOptional);

// The Pane brand mark — same shape as the pane shell's header logo
// (src/bridge/routes.ts) so the system pages and the live pane read as one
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
// palette onto the same navy the pane shell uses.
// Tab icons used by both the top tab bar (desktop) and the bottom tab bar
// (mobile). Tiny inline SVGs — no network round-trip, no font dependency,
// no FOUC. Each is sized via CSS (currentColor, 22px) so it inherits the
// active/inactive tab color uniformly.
const TAB_ICONS: Record<string, string> = {
  home: `<svg class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg>`,
  catalog: `<svg class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/></svg>`,
  panes: `<svg class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>`,
  templates: `<svg class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h13l3 3v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 11h8M8 15h5"/></svg>`,
  agents: `<svg class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="9" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/></svg>`,
  trash: `<svg class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1.2 13a1 1 0 0 0 1 .9h7.6a1 1 0 0 0 1-.9L18 7"/></svg>`,
  settings: `<svg class="tab-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2.6"/><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.5-2-3.5-2.4.9a7.5 7.5 0 0 0-1.7-1L14.5 3h-5l-.8 2.4a7.5 7.5 0 0 0-1.7 1L4.6 5.5l-2 3.5L4.6 11a7.5 7.5 0 0 0 0 2L2.6 14.5l2 3.5 2.4-.9a7.5 7.5 0 0 0 1.7 1L9.5 21h5l.8-2.4a7.5 7.5 0 0 0 1.7-1l2.4.9 2-3.5L19.4 13z"/></svg>`,
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
  header.pane-nav .brand svg { display: block; border-radius: 7px; }
  header.pane-nav .brand .wordmark { font-weight: 700; font-size: 16px; letter-spacing: -0.02em; }
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
  .pane-cards { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  .pane-card { display: grid; grid-template-columns: 48px 1fr auto; gap: 14px; align-items: center; padding: 14px; background: var(--bg); border: 1px solid var(--rule); border-radius: 12px; }
  @media (min-width: 640px) { .pane-card { padding: 16px 18px; gap: 18px; } }
  .pane-card-tile { width: 48px; height: 48px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 17px; letter-spacing: 0.04em; color: #fff; background: linear-gradient(135deg, hsl(var(--tile-h,260), 70%, 55%) 0%, hsl(calc(var(--tile-h,260) + 30), 65%, 45%) 100%); flex: none; user-select: none; }
  .pane-card-main { min-width: 0; }
  .pane-card-title { font-weight: 600; font-size: 15.5px; overflow-wrap: anywhere; }
  .pane-card-meta { font-size: 13px; color: var(--fg); overflow-wrap: anywhere; margin-top: 2px; }
  .pane-card-meta-dim { color: var(--muted); }
  .pane-card-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  @media (max-width: 540px) {
    .pane-card { grid-template-columns: 44px 1fr; }
    .pane-card-actions { grid-column: 1 / -1; justify-content: flex-start; padding-top: 4px; border-top: 1px dashed var(--rule); }
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
    ${nav("home", "Home", "/home")}
    ${nav("catalog", "Template store", "/template-store")}
    ${nav("panes", "My panes", "/my-panes")}
    ${nav("templates", "My templates", "/my-templates")}
    ${nav("agents", "My agents", "/my-agents")}
    ${nav("trash", "Trash", "/trash")}
    ${nav("settings", "Settings", "/settings")}
  </nav>
</header>
<main>
  ${args.body}
</main>
<nav class="bottom-tabs" aria-label="Primary (mobile)">
  <div class="tabs">
    ${nav("home", "Home", "/home")}
    ${nav("catalog", "Store", "/template-store")}
    ${nav("panes", "Panes", "/my-panes")}
    ${nav("templates", "Templates", "/my-templates")}
    ${nav("settings", "Settings", "/settings")}
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
// GET /favicon.svg — the brand mark as a real asset, referenced from
// /manifest.webmanifest (PWA install) and as a fallback for any client
// that doesn't pick up the inlined data URI used in <link rel="icon">.
// The SVG body is the same shape that's inlined in the bridge shell —
// kept here as a literal so updating the brand is a one-line change.
// ----------------------------------------------------------------------
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0f172a"/><circle cx="62" cy="58" r="17" fill="#22d3ee"/><rect x="20" y="26" width="40" height="32" rx="10" fill="#0f172a"/><rect x="24" y="30" width="32" height="24" rx="7" fill="#a78bfa"/><circle cx="33.5" cy="42" r="3.4" fill="#0f172a"/><circle cx="46.5" cy="42" r="3.4" fill="#0f172a"/></svg>`;

systemPages.get("/favicon.svg", (c) => {
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(FAVICON_SVG);
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
            <label for="email" style="font-size:13px;color:var(--muted);margin-bottom:6px;">Email</label>
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
// GET /home — iOS-style launcher.
//
// Three sections on a logged-in home:
//   1. Apps grid — 6 tiles linking to the major destinations. Each is a
//      large rounded square with a gradient + icon, like a phone home
//      screen. The same tile sizes drive desktop + mobile.
//   2. Favourites — the human's installed templates, surfaced as small
//      square tiles with the template initials. Lets the human launch a
//      pane from the home page without navigating to /my-templates.
//      Empty → CTA to /template-store.
//   3. Recents — the three most recent owned/joined panes as visual
//      cards (same pane-card pattern as /my-panes).
//
// The visual language matches the prototype at /tmp/owner-shell-v2.html:
// chunky rounded tiles, vivid gradients, generous whitespace. Looks at
// home in standalone PWA mode after Add-to-Home-Screen.
// ----------------------------------------------------------------------
systemPages.get("/home", async (c) => {
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "Home", email: null, body: loggedOutPrompt() }),
    );
  }
  const prisma = c.get("prisma");

  // Pull recent panes + installed templates in parallel.
  const [recent, installs] = await Promise.all([
    prisma.pane.findMany({
      where: {
        deletedAt: null,
        OR: [
          { ownerHumanId: human.id },
          { participants: { some: { humanId: human.id, revokedAt: null } } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 4,
      select: {
        id: true,
        title: true,
        createdAt: true,
        templateVersion: {
          select: { template: { select: { name: true, slug: true } } },
        },
      },
    }),
    prisma.humanTemplateInstall.findMany({
      where: { humanId: human.id, uninstalledAt: null },
      orderBy: { installedAt: "desc" },
      take: 8,
      select: {
        templateId: true,
        template: {
          select: { name: true, slug: true, id: true, deletedAt: true },
        },
      },
    }),
  ]);
  const liveInstalls = installs.filter((i) => i.template.deletedAt === null);

  // 1) Apps grid — six destinations. Each tile is a link with an SVG icon
  //    and a label. Gradient colors are hand-picked so the row reads as a
  //    palette, not a random assortment.
  const APP_TILES: Array<{
    href: string;
    label: string;
    grad: [string, string];
    icon: string;
  }> = [
    {
      href: "/my-panes",
      label: "Panes",
      grad: ["#7c3aed", "#a78bfa"],
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>`,
    },
    {
      href: "/my-templates",
      label: "Templates",
      grad: ["#0ea5e9", "#38bdf8"],
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h13l3 3v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 11h8M8 15h5"/></svg>`,
    },
    {
      href: "/template-store",
      label: "Store",
      grad: ["#10b981", "#34d399"],
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/></svg>`,
    },
    {
      href: "/my-agents",
      label: "Agents",
      grad: ["#ec4899", "#f472b6"],
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/></svg>`,
    },
    {
      href: "/trash",
      label: "Trash",
      grad: ["#64748b", "#94a3b8"],
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1.2 13a1 1 0 0 0 1 .9h7.6a1 1 0 0 0 1-.9L18 7"/></svg>`,
    },
    {
      href: "/settings",
      label: "Settings",
      grad: ["#f59e0b", "#fbbf24"],
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.6"/><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.5-2-3.5-2.4.9a7.5 7.5 0 0 0-1.7-1L14.5 3h-5l-.8 2.4a7.5 7.5 0 0 0-1.7 1L4.6 5.5l-2 3.5L4.6 11a7.5 7.5 0 0 0 0 2L2.6 14.5l2 3.5 2.4-.9a7.5 7.5 0 0 0 1.7 1L9.5 21h5l.8-2.4a7.5 7.5 0 0 0 1.7-1l2.4.9 2-3.5L19.4 13z"/></svg>`,
    },
  ];
  const appsGrid = APP_TILES.map(
    (
      t,
    ) => `<a class="launcher-tile" href="${t.href}" style="background:linear-gradient(135deg,${t.grad[0]} 0%,${t.grad[1]} 100%);">
      <span class="launcher-icon">${t.icon}</span>
      <span class="launcher-label">${escapeHtml(t.label)}</span>
    </a>`,
  ).join("");

  // 2) Favourites — installed templates. Each launches a pane via the
  //    cookie-authed POST /v1/my-templates/:id/launch endpoint, mirroring
  //    the Launch button on /my-templates. Smaller tile, template initials
  //    on a hash-coloured background so visually distinct from the apps
  //    grid above. Tap → mint + redirect to the new pane URL.
  const favouritesGrid =
    liveInstalls.length === 0
      ? `<div class="empty-state" style="padding:24px 16px 18px;">
          <h3 class="empty-state-headline" style="margin:0 0 4px;font-size:15px;">No favourites yet</h3>
          <p class="empty-state-body" style="font-size:13.5px;margin:0;">Install a template from the <a href="/template-store">store</a> — it'll appear here for one-tap launch.</p>
        </div>`
      : `<div class="fav-grid">${liveInstalls
          .map((i) => {
            const t = i.template;
            const name = t.name ?? t.slug ?? t.id;
            const initials = paneInitials(name);
            const hue = paneHue(t.id);
            return `<button class="fav-tile" data-template-id="${escapeHtml(t.id)}" data-template-name="${escapeHtml(name)}" style="--tile-h:${hue};">
              <span class="fav-tile-initials">${escapeHtml(initials)}</span>
              <span class="fav-tile-label">${escapeHtml(name)}</span>
            </button>`;
          })
          .join("")}</div>`;

  // 3) Recents — visual cards. Reuses .pane-card styling from /my-panes.
  const now = new Date();
  const recentsBlock =
    recent.length === 0
      ? `<div class="empty-state" style="padding:20px 16px 10px;">
          <p class="empty-state-body" style="font-size:13.5px;margin:0;">No recent panes — launch one from a favourite above.</p>
        </div>`
      : `<ul class="pane-cards">${recent
          .map((s) => {
            const tplName =
              s.templateVersion?.template?.name ??
              s.templateVersion?.template?.slug ??
              s.title;
            const initials = paneInitials(tplName);
            const hue = paneHue(s.id);
            const rel = formatRelativeDate(s.createdAt, now);
            return `<li class="pane-card" style="--tile-h:${hue};">
              <div class="pane-card-tile">${escapeHtml(initials)}</div>
              <div class="pane-card-main">
                <div class="pane-card-title">${escapeHtml(s.title)}</div>
                <div class="pane-card-meta"><span class="pane-card-meta-dim">${escapeHtml(tplName)} · ${escapeHtml(rel)}</span></div>
              </div>
              <div class="pane-card-actions"><a class="btn ghost" href="/panes/${encodeURIComponent(s.id)}">Open</a></div>
            </li>`;
          })
          .join("")}</ul>`;

  const body = `<style>
    /* Launcher home — the iOS-style chunky-tile layout. Local-only styles
       (not pushed to layout.ts) so the visual treatment can iterate
       without churning every other page. */
    .home-hero { margin: 4px 0 22px; }
    .home-hero h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.02em; }
    @media (min-width: 640px) { .home-hero h1 { font-size: 30px; } }
    .home-hero .home-hello { color: var(--muted); font-size: 14.5px; margin: 0; }

    .launcher-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin: 18px 0 28px;
    }
    @media (min-width: 480px) { .launcher-grid { grid-template-columns: repeat(6, 1fr); gap: 14px; } }
    .launcher-tile {
      aspect-ratio: 1 / 1;
      border-radius: 18px;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 4px;
      color: #fff; text-decoration: none;
      box-shadow: 0 6px 14px rgba(16,21,34,.18), 0 1px 2px rgba(16,21,34,.12);
      transition: transform .14s ease, box-shadow .14s ease;
    }
    .launcher-tile:hover { transform: translateY(-2px); box-shadow: 0 10px 22px rgba(16,21,34,.22), 0 2px 4px rgba(16,21,34,.14); }
    .launcher-tile:active { transform: translateY(0); }
    .launcher-icon { width: 32px; height: 32px; }
    .launcher-icon svg { width: 100%; height: 100%; display: block; }
    .launcher-label {
      font-size: 11px; font-weight: 600; letter-spacing: 0.03em;
      text-transform: uppercase;
      opacity: 0.95;
    }
    @media (min-width: 480px) { .launcher-icon { width: 36px; height: 36px; } .launcher-label { font-size: 12px; } }

    .home-section { margin: 26px 0 16px; }
    .home-section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
    .home-section-head h2 { margin: 0; font-size: 16px; letter-spacing: -0.005em; }
    .home-section-head a { font-size: 13px; }

    /* Favourites — smaller tiles, two rows on mobile, more per row on
       desktop. Hash-coloured tile + initials so the same visual key as
       /my-panes cards. */
    .fav-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
      gap: 12px;
    }
    .fav-tile {
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      padding: 14px 8px; background: var(--panel); border: 1px solid var(--rule);
      border-radius: 14px; cursor: pointer; font: inherit; text-align: center;
      transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease;
    }
    .fav-tile:hover { transform: translateY(-1px); border-color: var(--accent); box-shadow: 0 4px 14px rgba(16,21,34,.08); }
    .fav-tile:disabled { opacity: 0.65; cursor: default; }
    .fav-tile-initials {
      width: 44px; height: 44px; border-radius: 12px;
      display: inline-flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 15px; letter-spacing: 0.04em;
      color: #fff;
      background: linear-gradient(135deg, hsl(var(--tile-h,260), 70%, 55%) 0%, hsl(calc(var(--tile-h,260) + 30), 65%, 45%) 100%);
    }
    .fav-tile-label {
      font-size: 12.5px; color: var(--fg);
      max-width: 100%;
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      line-height: 1.25;
    }
  </style>
  <div class="home-hero">
    <h1>Hello</h1>
    <p class="home-hello">Signed in as ${escapeHtml(human.email)}.</p>
  </div>

  <div class="launcher-grid">
    ${appsGrid}
  </div>

  <section class="home-section">
    <div class="home-section-head">
      <h2>Favourites</h2>
      <a href="/my-templates">My templates →</a>
    </div>
    ${favouritesGrid}
  </section>

  <section class="home-section">
    <div class="home-section-head">
      <h2>Recent panes</h2>
      <a href="/my-panes">All panes →</a>
    </div>
    ${recentsBlock}
  </section>

  <script>
    // Favourite tile → one-tap pane launch via the cookie-authed launch
    // endpoint. Same flow as the Launch button on /my-templates: server
    // mints the pane + human token, returns the URL, we navigate.
    document.querySelectorAll('.fav-tile').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-template-id');
        if (!id) return;
        const original = btn.querySelector('.fav-tile-label').textContent;
        btn.disabled = true;
        btn.querySelector('.fav-tile-label').textContent = 'Launching…';
        try {
          const res = await fetch('/v1/my-templates/' + encodeURIComponent(id) + '/launch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
          });
          if (!res.ok) {
            btn.disabled = false;
            btn.querySelector('.fav-tile-label').textContent = original;
            alert('Launch failed (HTTP ' + res.status + ')');
            return;
          }
          const body = await res.json();
          const url = body.urls && body.urls.humans && body.urls.humans[0];
          if (!url) {
            btn.disabled = false;
            btn.querySelector('.fav-tile-label').textContent = original;
            alert('Launch failed — no pane URL returned.');
            return;
          }
          window.location.href = url;
        } catch (e) {
          btn.disabled = false;
          btn.querySelector('.fav-tile-label').textContent = original;
          alert('Network error — try again.');
        }
      });
    });
  </script>`;
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
// GET /my-panes — list of panes the human owns
// ----------------------------------------------------------------------
systemPages.get("/my-panes", async (c) => {
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "My panes", email: null, body: loggedOutPrompt() }),
    );
  }
  const prisma = c.get("prisma");
  // #301 — show every pane this human has access to: ones they own AND
  // ones they joined as a participant. Previously only ownerHumanId rows
  // surfaced here, so a human who opened someone else's invited pane had
  // no "where did that go" page. The dedup-by-id is implicit via Prisma
  // findMany on a single table — a human who is BOTH owner and identity-
  // bound participant on the same pane shows up exactly once. Revoked
  // participants are filtered out so a kicked human's panes don't linger
  // on their list.
  // #305 — hide soft-deleted panes from /my-panes by default. The /trash
  // page (#309) is the dedicated trash view; #310 lets the human opt
  // soft-deleted rows back into this view via ?show_deleted=true so they
  // can see "everything I have, live and trashed" in one list without
  // tab-hopping.
  const showDeleted = c.req.query("show_deleted") === "true";
  const panes = await prisma.pane.findMany({
    where: {
      ...(showDeleted ? {} : { deletedAt: null }),
      OR: [
        { ownerHumanId: human.id },
        { participants: { some: { humanId: human.id, revokedAt: null } } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      createdAt: true,
      expiresAt: true,
      deletedAt: true,
      agent: { select: { name: true } },
      templateVersion: {
        select: {
          template: { select: { name: true, slug: true } },
        },
      },
    },
  });
  // #310 — toggle between "live only" (default) and "show trashed too".
  // The link is rendered as a small text-button in the page header so the
  // human can flip the view without leaving for /trash. /trash remains the
  // dedicated home for restore/purge actions.
  const toggleLink = showDeleted
    ? `<a class="btn ghost" href="/my-panes" style="padding:6px 14px;font-size:13px;">Hide trashed</a>`
    : `<a class="btn ghost" href="/my-panes?show_deleted=true" style="padding:6px 14px;font-size:13px;">Show trashed</a>`;
  const body = `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <h1 style="margin:0;">My panes</h1>
    ${toggleLink}
  </div>
  <p style="color:var(--muted);font-size:14.5px;">Panes you own. Panes created by claimed agents on your behalf appear here.</p>
  <div class="card">
    ${
      panes.length === 0
        ? `<div class="empty-state">
            <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 8h18"/><circle cx="7" cy="6" r=".7" fill="currentColor"/><circle cx="10" cy="6" r=".7" fill="currentColor"/></svg>
            <h3 class="empty-state-headline">No panes yet</h3>
            <p class="empty-state-body">A pane is one UI an agent renders for you. As soon as one of your claimed agents creates one, it shows up here.</p>
            <div class="empty-state-cta"><a class="btn ghost" href="/my-agents">Claim an agent</a><a class="btn" href="/template-store">Browse the template store</a></div>
          </div>`
        : `<ul class="pane-cards">${panes
            .map((s) => {
              const isTrashed = s.deletedAt !== null;
              const isActive =
                !isTrashed &&
                s.status === "open" &&
                s.expiresAt.getTime() > Date.now();
              const statusBadge = isTrashed
                ? `<span class="pill" style="background:#fff4ec;color:#b34700;">Trashed</span>`
                : isActive
                  ? `<span class="pill good">Active</span>`
                  : `<span class="pill muted">Closed</span>`;
              // Open is an actual link to the cookie-authed owner shell
              // (/panes/:id) — distinct from the share-link path
              // (/s/:token). No participant token in the URL; the pane_login
              // cookie does the auth, so a stolen URL is inert. Trashed
              // panes 404 on the owner shell (see loadOwnedPane #305), so
              // we skip the Open button for them — /trash has Restore +
              // Purge instead.
              const openAction = isActive
                ? `<a class="btn ghost" href="/panes/${encodeURIComponent(s.id)}" style="padding:6px 14px;font-size:13px;">Open</a>`
                : "";
              const templateName =
                s.templateVersion.template.name ??
                s.templateVersion.template.slug ??
                "ad-hoc template";
              const agentName = s.agent.name;
              const initials = paneInitials(templateName);
              const hue = paneHue(s.id);
              const createdLabel = formatRelativeDate(s.createdAt, new Date());
              return `<li class="pane-card"${isTrashed ? ' style="opacity:0.6;"' : ""}>
                <div class="pane-card-tile" style="--tile-h:${hue};" aria-hidden="true">${escapeHtml(initials)}</div>
                <div class="pane-card-main">
                  <div class="pane-card-title">${escapeHtml(s.title)}</div>
                  <div class="pane-card-meta">${escapeHtml(templateName)} · ${escapeHtml(agentName)}</div>
                  <div class="pane-card-meta pane-card-meta-dim"><code>${escapeHtml(s.id)}</code> · created ${escapeHtml(createdLabel)}</div>
                </div>
                <div class="pane-card-actions">${statusBadge}${openAction}</div>
              </li>`;
            })
            .join("")}</ul>`
    }
  </div>`;
  return c.html(
    layout({
      title: "My panes",
      email: human.email,
      body,
      active: "panes",
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
  // #310 — show-deleted toggle: same UX as /my-panes.
  const showDeleted = c.req.query("show_deleted") === "true";
  const [templates, installs] = await Promise.all([
    prisma.template.findMany({
      // #305 — soft-deleted templates live on /trash by default; #310 opt-in.
      where: {
        ...(showDeleted ? {} : { deletedAt: null }),
        owner: { ownerHumanId: human.id },
      },
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
        scopes: true,
        installCount: true,
        deletedAt: true,
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
  <div class="card" id="installed-card">
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
        // Launch button: hits POST /v1/my-templates/:id/launch, navigates to
        // the resulting pane URL. Disabled when the upgrade is blocked so
        // the human resolves the schema mismatch first.
        const launchBtn = i.upgradeBlockedAt
          ? `<button class="btn" data-act="launch" data-id="${escapeHtml(i.template.id)}" disabled title="Resolve the upgrade-blocked state before launching.">Launch</button>`
          : `<button class="btn" data-act="launch" data-id="${escapeHtml(i.template.id)}">Launch</button>`;
        return `<li data-install-id="${escapeHtml(i.template.id)}"><div style="min-width:0;flex:1;"><div class="title">${escapeHtml(i.template.name ?? i.template.slug ?? i.template.id)}</div><div class="meta">installed v${i.installedVersion}</div>${blockedNote}<div class="launch-status meta" style="margin-top:4px;color:var(--muted);"></div></div><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${policyPill}${newerAvailable}${blockedPill}${launchBtn}</div></li>`;
      })
      .join("")}</ul>
  </div>
  <script>
    (function () {
      const card = document.getElementById('installed-card');
      if (!card) return;
      card.addEventListener('click', async (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest('button[data-act="launch"]');
        if (!btn) return;
        const li = btn.closest('li[data-install-id]');
        if (!li) return;
        const id = btn.getAttribute('data-id');
        const status = li.querySelector('.launch-status');
        const originalLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Launching…';
        if (status) status.textContent = '';
        try {
          const res = await fetch('/v1/my-templates/' + encodeURIComponent(id) + '/launch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: '{}',
          });
          if (!res.ok) {
            btn.disabled = false;
            btn.textContent = originalLabel;
            let detail = 'HTTP ' + res.status;
            try {
              const errBody = await res.json();
              if (errBody && errBody.error && errBody.error.message) detail = errBody.error.message;
            } catch (_) {}
            if (status) status.textContent = 'Launch failed: ' + detail;
            return;
          }
          const body = await res.json();
          const url = body && body.urls && body.urls.humans && body.urls.humans[0];
          if (!url) {
            btn.disabled = false;
            btn.textContent = originalLabel;
            if (status) status.textContent = 'Launch failed: missing pane URL in response.';
            return;
          }
          window.location.href = url;
        } catch (_) {
          btn.disabled = false;
          btn.textContent = originalLabel;
          if (status) status.textContent = 'Network error — try again.';
        }
      });
    })();
  </script>`;
  const authoredList =
    templates.length === 0
      ? `<div class="empty-state">
          <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h7v7H4z"/><path d="M13 4h7v4h-7z"/><path d="M13 10h7v10h-7z"/><path d="M4 13h7v7H4z"/></svg>
          <h3 class="empty-state-headline">You haven't authored any templates</h3>
          <p class="empty-state-body">Templates are reusable mini-apps your agents create with <code>pane template create</code>. Once an agent saves one, it lives here — installs from the public catalog appear below.</p>
          <div class="empty-state-cta"><a class="btn ghost" href="/template-store">Browse the template store</a></div>
        </div>`
      : `<ul class="list">${templates
          .map((t) => {
            const title = escapeHtml(t.name ?? t.slug ?? t.id);
            const desc = t.description
              ? escapeHtml(t.description)
              : "<em>no description</em>";
            const isTrashed = t.deletedAt !== null;
            const statusPill = isTrashed
              ? `<span class="pill" style="background:#fff4ec;color:#b34700;">Trashed</span>`
              : t.publishedAt
                ? `<span class="pill good">Published · ${t.installCount} installs</span>`
                : `<span class="pill muted">Private</span>`;
            const scopesCsv = ((t.scopes as string[] | null) ?? []).join(", ");
            const btnLabel = t.publishedAt ? "Unpublish" : "Publish to catalog";
            const btnAct = t.publishedAt ? "unpublish" : "publish";
            return `<li data-template-id="${escapeHtml(t.id)}" data-published="${t.publishedAt ? "1" : "0"}">
              <div style="min-width:0;flex:1;">
                <div class="title">${title}</div>
                <div class="meta">${desc} · ${escapeHtml(t.shape)}</div>
                <div class="meta" style="margin-top:6px;"><a href="/my-templates/${encodeURIComponent(t.id)}/content" style="font-size:13px;">Manage content →</a></div>
                <details class="pub-form" style="margin-top:6px;">
                  <summary style="cursor:pointer;font-size:13px;color:var(--accent);">${btnLabel}</summary>
                  <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:12.5px;color:var(--muted);">Scopes</label>
                    <div class="help" style="font-size:12px;color:var(--muted);line-height:1.45;">Format: <code>&lt;action&gt;:&lt;resource&gt;</code> where action is one of <code>read</code>, <code>write</code>, <code>delete</code>. Examples: <code>read:profile</code>, <code>write:posts</code>, <code>delete:comments</code>. Comma-separated for multiple. Leave blank to keep current scopes.</div>
                    <textarea class="scopes" rows="2" style="width:100%;border:1px solid var(--rule);border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;" placeholder="read:profile, write:posts">${escapeHtml(scopesCsv)}</textarea>
                    <div style="display:flex;gap:8px;align-items:center;">
                      <button class="btn" data-act="${btnAct}" type="button">${btnLabel}</button>
                      <span class="pub-status" style="color:var(--muted);font-size:13px;"></span>
                    </div>
                  </div>
                </details>
              </div>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${statusPill}</div>
            </li>`;
          })
          .join("")}</ul>
        <script>
          (function () {
            const card = document.currentScript.previousElementSibling;
            if (!card) return;
            card.addEventListener('click', async (ev) => {
              const target = ev.target;
              if (!(target instanceof HTMLElement)) return;
              const btn = target.closest('button[data-act]');
              if (!btn) return;
              const li = btn.closest('li[data-template-id]');
              if (!li) return;
              const id = li.getAttribute('data-template-id');
              const act = btn.getAttribute('data-act');
              const status = li.querySelector('.pub-status');
              btn.disabled = true;
              status.textContent = act === 'publish' ? 'Publishing…' : 'Unpublishing…';
              let body = '{}';
              if (act === 'publish') {
                const ta = li.querySelector('textarea.scopes');
                const raw = (ta && ta.value || '').trim();
                if (raw) {
                  const scopes = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
                  body = JSON.stringify({ scopes });
                }
              }
              try {
                const res = await fetch('/v1/my-templates/' + encodeURIComponent(id) + '/' + act, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  credentials: 'same-origin',
                  body,
                });
                if (!res.ok) {
                  btn.disabled = false;
                  let detail = 'HTTP ' + res.status;
                  try {
                    const errBody = await res.json();
                    // Zod validation errors carry detailed field info under
                    // error.details.message (a stringified JSON array of
                    // issues). Surface the first issue's path + message so
                    // the user sees what went wrong, e.g.
                    //   "scopes.0 — Invalid string: must match pattern …".
                    // Fallback to error.message for everything else.
                    const errObj = errBody && errBody.error;
                    if (errObj && errObj.details && errObj.details.name === 'ZodError' && typeof errObj.details.message === 'string') {
                      try {
                        const issues = JSON.parse(errObj.details.message);
                        if (Array.isArray(issues) && issues.length > 0) {
                          const issue = issues[0];
                          const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
                          const msg = issue.message || (errObj.message || 'invalid input');
                          detail = path ? (path + ' — ' + msg) : msg;
                        } else if (errObj.message) {
                          detail = errObj.message;
                        }
                      } catch (_) {
                        if (errObj.message) detail = errObj.message;
                      }
                    } else if (errObj && errObj.message) {
                      detail = errObj.message;
                    }
                  } catch (_) {}
                  status.textContent = (act === 'publish' ? 'Publish' : 'Unpublish') + ' failed: ' + detail;
                  return;
                }
                status.textContent = 'Done. Reloading…';
                window.location.reload();
              } catch (_) {
                btn.disabled = false;
                status.textContent = 'Network error — try again.';
              }
            });
          })();
        </script>`;
  // #310 — show-deleted toggle in the page header.
  const templatesToggleLink = showDeleted
    ? `<a class="btn ghost" href="/my-templates" style="padding:6px 14px;font-size:13px;">Hide trashed</a>`
    : `<a class="btn ghost" href="/my-templates?show_deleted=true" style="padding:6px 14px;font-size:13px;">Show trashed</a>`;
  const body = `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <h1 style="margin:0;">My templates</h1>
    ${templatesToggleLink}
  </div>
  <p style="color:var(--muted);font-size:14.5px;">Templates created by agents you own. Templates you've installed from the public catalog appear below.</p>
  <h2>Authored</h2>
  <div class="card">
    ${authoredList}
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
  const name = template.name ?? template.slug ?? template.id;
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
systemPages.get("/apps", (c) => c.redirect("/template-store", 301));
systemPages.get("/public-templates", (c) => c.redirect("/template-store", 301));

systemPages.get("/template-store", (c) => {
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({
        title: "Template store",
        email: null,
        body: loggedOutPrompt(),
      }),
    );
  }
  const body = `<h1>Template store</h1>
  <p style="color:var(--muted);font-size:14.5px;">Templates published by other agents. Install one to add it to your library — then hit Launch on <a href="/my-templates">My templates</a> to open a pane.</p>
  <div class="card">
    <input id="catalog-search" type="text" placeholder="Search templates by name, description, or tag" autocomplete="off" />
    <div id="catalog-results" style="margin-top:14px;"></div>
  </div>
  <script>
    const resultsEl = document.getElementById("catalog-results");
    const searchEl = document.getElementById("catalog-search");

    function escape(s) {
      return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function renderItems(items, query) {
      if (!items.length) {
        // Two empty states: search-miss (user typed something) vs. an empty
        // catalog on first load. Different copy, different CTA.
        if (query) {
          resultsEl.innerHTML = '<p class="empty">No templates match "' + escape(query) + '". Try fewer or different keywords.</p>';
        } else {
          resultsEl.innerHTML = '<div class="empty-state">'
            + '<svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/></svg>'
            + '<h3 class="empty-state-headline">The public catalog is empty</h3>'
            + '<p class="empty-state-body">Once agents publish templates with <code>pane template publish &lt;id-or-slug&gt;</code>, the catalog appears here. Your own authored templates live on <a href="/my-templates">My templates</a>.</p>'
            + '</div>';
        }
        return;
      }
      const html = '<ul class="list">' + items.map((t) => {
        const name = t.name || t.slug || t.id;
        const tags = (t.tags || []).map((x) => '<span class="pill muted">' + escape(x) + '</span>').join(' ');
        const installedPill = t.installed
          ? '<span class="pill good">Installed v' + escape(t.installed_version) + '</span>'
          : '';
        const btn = t.installed
          ? '<button class="btn ghost" data-act="uninstall" data-id="' + escape(t.id) + '">Uninstall</button>'
          : '<button class="btn" data-act="install" data-id="' + escape(t.id) + '">Install</button>';
        return '<li><div style="min-width:0;flex:1;"><div class="title">' + escape(name) + '</div>'
          + '<div class="meta">' + (t.description ? escape(t.description) : '<em>no description</em>') + '</div>'
          + (tags ? '<div class="meta" style="margin-top:4px;">' + tags + '</div>' : '')
          + '<div class="meta" style="margin-top:4px;">' + escape(t.install_count) + ' installs · latest v' + escape(t.latest_version) + '</div>'
          + '</div>'
          + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' + installedPill + btn + '</div></li>';
      }).join('') + '</ul>';
      resultsEl.innerHTML = html;
    }

    async function load(q) {
      const url = '/v1/templates/public' + (q ? ('?q=' + encodeURIComponent(q)) : '');
      resultsEl.textContent = 'Loading…';
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) {
          resultsEl.textContent = 'Failed to load templates (' + res.status + ').';
          return;
        }
        const body = await res.json();
        renderItems(body.items || [], q || "");
      } catch (e) {
        resultsEl.textContent = 'Network error — try again.';
      }
    }

    // Debounce typing.
    let debounce = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => load(searchEl.value.trim()), 200);
    });

    // Install / Uninstall click delegation.
    resultsEl.addEventListener('click', async (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      if (!act || !id) return;
      btn.disabled = true;
      btn.textContent = act === 'install' ? 'Installing…' : 'Uninstalling…';
      try {
        const res = await fetch('/v1/templates/' + encodeURIComponent(id) + '/' + act, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: act === 'install' ? '{}' : undefined,
        });
        if (!res.ok && res.status !== 204) {
          btn.disabled = false;
          btn.textContent = act === 'install' ? 'Install' : 'Uninstall';
          alert((act === 'install' ? 'Install' : 'Uninstall') + ' failed: HTTP ' + res.status);
          return;
        }
      } catch (e) {
        btn.disabled = false;
        alert('Network error — try again.');
        return;
      }
      // Reload to reflect new installed state.
      load(searchEl.value.trim());
    });

    load('');
  </script>`;
  return c.html(
    layout({
      title: "Template store",
      email: human.email,
      body,
      active: "catalog",
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
systemPages.get("/trash", async (c) => {
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "Trash", email: null, body: loggedOutPrompt() }),
    );
  }
  const prisma = c.get("prisma");
  const [panes, templates] = await Promise.all([
    prisma.pane.findMany({
      where: {
        deletedAt: { not: null },
        OR: [{ ownerHumanId: human.id }, { agent: { ownerHumanId: human.id } }],
      },
      orderBy: { deletedAt: "desc" },
      select: {
        id: true,
        title: true,
        deletedAt: true,
        agent: { select: { name: true } },
        templateVersion: {
          select: { template: { select: { name: true, slug: true } } },
        },
      },
      take: 200,
    }),
    prisma.template.findMany({
      where: {
        deletedAt: { not: null },
        owner: { ownerHumanId: human.id },
      },
      orderBy: { deletedAt: "desc" },
      select: { id: true, name: true, slug: true, deletedAt: true },
      take: 200,
    }),
  ]);

  const now = new Date();
  const panesSection =
    panes.length === 0
      ? `<p style="color:var(--muted);font-size:14px;">No panes in trash.</p>`
      : `<ul class="list" id="trash-panes">${panes
          .map((p) => {
            const templateName =
              p.templateVersion.template.name ??
              p.templateVersion.template.slug ??
              "ad-hoc template";
            const deletedLabel = formatRelativeDate(p.deletedAt as Date, now);
            return `<li data-pane-id="${escapeHtml(p.id)}">
              <div style="min-width:0;flex:1;">
                <div class="title">${escapeHtml(p.title)}</div>
                <div class="meta">${escapeHtml(templateName)} · ${escapeHtml(p.agent.name)}</div>
                <div class="meta" style="color:var(--muted);"><code>${escapeHtml(p.id)}</code> · trashed ${escapeHtml(deletedLabel)}</div>
              </div>
              <div style="display:flex;gap:6px;align-items:center;">
                <button class="btn ghost" type="button" data-act="restore-pane" data-id="${escapeHtml(p.id)}" style="padding:6px 12px;font-size:13px;min-height:36px;">Restore</button>
                <button class="btn ghost" type="button" data-act="purge-pane" data-id="${escapeHtml(p.id)}" style="padding:6px 12px;font-size:13px;min-height:36px;color:#a4361b;">Delete forever</button>
                <span class="trash-status" style="color:var(--muted);font-size:13px;"></span>
              </div>
            </li>`;
          })
          .join("")}</ul>`;

  const templatesSection =
    templates.length === 0
      ? `<p style="color:var(--muted);font-size:14px;">No templates in trash.</p>`
      : `<ul class="list" id="trash-templates">${templates
          .map((t) => {
            const title = escapeHtml(t.name ?? t.slug ?? t.id);
            const deletedLabel = formatRelativeDate(t.deletedAt as Date, now);
            return `<li data-template-id="${escapeHtml(t.id)}">
              <div style="min-width:0;flex:1;">
                <div class="title">${title}</div>
                <div class="meta" style="color:var(--muted);"><code>${escapeHtml(t.id)}</code> · trashed ${escapeHtml(deletedLabel)}</div>
              </div>
              <div style="display:flex;gap:6px;align-items:center;">
                <button class="btn ghost" type="button" data-act="restore-template" data-id="${escapeHtml(t.id)}" style="padding:6px 12px;font-size:13px;min-height:36px;">Restore</button>
                <button class="btn ghost" type="button" data-act="purge-template" data-id="${escapeHtml(t.id)}" style="padding:6px 12px;font-size:13px;min-height:36px;color:#a4361b;">Delete forever</button>
                <span class="trash-status" style="color:var(--muted);font-size:13px;"></span>
              </div>
            </li>`;
          })
          .join("")}</ul>`;

  const isEmpty = panes.length === 0 && templates.length === 0;
  const body = `<h1>Trash</h1>
  <p style="color:var(--muted);font-size:14.5px;">Items here are recoverable. Free-tier rows are permanently deleted 30 days after they land in trash; paid-tier rows are kept until you delete them. "Delete forever" skips the wait.</p>
  ${
    isEmpty
      ? `<div class="card"><div class="empty-state">
          <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          <h3 class="empty-state-headline">Nothing in trash</h3>
          <p class="empty-state-body">Closed panes and deleted templates land here for recovery.</p>
        </div></div>`
      : `<h2 style="margin-top:18px;">Panes (${panes.length})</h2>
         <div class="card">${panesSection}</div>
         <h2 style="margin-top:24px;">Templates (${templates.length})</h2>
         <div class="card">${templatesSection}</div>`
  }
  <script>
    (function() {
      const root = document.querySelector('main');
      if (!root) return;
      root.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        if (!act || !id) return;
        const verb = act.startsWith('restore') ? 'Restore' : 'Delete forever';
        if (act.startsWith('purge')) {
          // Permanent delete confirms — the hard-delete sweeper would
          // eventually reclaim the row, but an explicit purge skips that
          // window and is irreversible.
          const ok = confirm('Permanently delete this ' + (act.endsWith('pane') ? 'pane' : 'template') + '? This cannot be undone.');
          if (!ok) return;
        }
        const li = btn.closest('li');
        const status = li ? li.querySelector('.trash-status') : null;
        // Disable both buttons on the row so a double-click can't fire a
        // restore + purge race against the same row.
        const buttons = li ? li.querySelectorAll('button[data-act]') : [];
        buttons.forEach(b => { b.disabled = true; });
        if (status) status.textContent = (verb === 'Restore' ? 'Restoring…' : 'Deleting…');
        const isPane = act.endsWith('pane');
        const path = isPane
          ? '/v1/my-trash/panes/' + encodeURIComponent(id) + (act.startsWith('restore') ? '/restore' : '')
          : '/v1/my-trash/templates/' + encodeURIComponent(id) + (act.startsWith('restore') ? '/restore' : '');
        const method = act.startsWith('restore') ? 'POST' : 'DELETE';
        try {
          const res = await fetch(path, { method, credentials: 'same-origin' });
          if (!res.ok && res.status !== 204) {
            let msg = 'HTTP ' + res.status;
            try {
              const body = await res.json();
              if (body && body.error) {
                msg = body.error.message || body.error.code || msg;
                if (body.error.hint) msg += ' — ' + body.error.hint;
              }
            } catch {}
            if (status) status.textContent = msg;
            buttons.forEach(b => { b.disabled = false; });
            return;
          }
          // Success: drop the row, and update the section count.
          if (li) li.remove();
          // If the section is now empty, reload to render the empty state.
          const remaining = document.querySelectorAll(
            '#trash-panes li, #trash-templates li',
          );
          if (remaining.length === 0) location.reload();
        } catch (e) {
          if (status) status.textContent = 'Network error';
          buttons.forEach(b => { b.disabled = false; });
        }
      });
    })();
  </script>`;
  return c.html(
    layout({ title: "Trash", email: human.email, body, active: "trash" }),
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
