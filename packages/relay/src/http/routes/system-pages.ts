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
    ${nav("apps", "Apps", "/apps")}
    ${nav("panes", "My panes", "/my-panes")}
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
  // Show a few recent panes the human owns, as quick links.
  const recent = await prisma.pane.findMany({
    where: { ownerHumanId: human.id },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, title: true, createdAt: true },
  });
  const recentBlock =
    recent.length === 0
      ? `<p class="empty">No panes yet.</p>`
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
      <li><div><div class="title">My panes</div><div class="meta">Panes you own or are a participant on</div></div><a class="btn ghost" href="/my-panes">Open</a></li>
      <li><div><div class="title">My templates</div><div class="meta">Templates owned by your agents</div></div><a class="btn ghost" href="/my-templates">Open</a></li>
      <li><div><div class="title">My agents</div><div class="meta">Agents you've claimed</div></div><a class="btn ghost" href="/my-agents">Open</a></li>
      <li><div><div class="title">Settings</div><div class="meta">Email, claim codes</div></div><a class="btn ghost" href="/settings">Open</a></li>
    </ul>
  </div>
  <div class="card">
    <h2>Recent panes</h2>
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
  const panes = await prisma.pane.findMany({
    where: {
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
      agent: { select: { name: true } },
      templateVersion: {
        select: {
          template: { select: { name: true, slug: true } },
        },
      },
    },
  });
  const body = `<h1>My panes</h1>
  <p style="color:var(--muted);font-size:14.5px;">Panes you own. Panes created by claimed agents on your behalf appear here.</p>
  <div class="card">
    ${
      panes.length === 0
        ? `<div class="empty-state">
            <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 8h18"/><circle cx="7" cy="6" r=".7" fill="currentColor"/><circle cx="10" cy="6" r=".7" fill="currentColor"/></svg>
            <h3 class="empty-state-headline">No panes yet</h3>
            <p class="empty-state-body">A pane is one UI an agent renders for you. As soon as one of your claimed agents creates one, it shows up here.</p>
            <div class="empty-state-cta"><a class="btn ghost" href="/my-agents">Claim an agent</a><a class="btn" href="/apps">Browse apps</a></div>
          </div>`
        : `<ul class="pane-cards">${panes
            .map((s) => {
              const isActive =
                s.status === "open" && s.expiresAt.getTime() > Date.now();
              const statusBadge = isActive
                ? `<span class="pill good">Active</span>`
                : `<span class="pill muted">Closed</span>`;
              // Open is an actual link to the cookie-authed owner shell
              // (/panes/:id) — distinct from the share-link path
              // (/s/:token). No participant token in the URL; the pane_login
              // cookie does the auth, so a stolen URL is inert.
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
              return `<li class="pane-card">
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
        scopes: true,
        installCount: true,
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
  const authoredList =
    templates.length === 0
      ? `<div class="empty-state">
          <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h7v7H4z"/><path d="M13 4h7v4h-7z"/><path d="M13 10h7v10h-7z"/><path d="M4 13h7v7H4z"/></svg>
          <h3 class="empty-state-headline">You haven't authored any templates</h3>
          <p class="empty-state-body">Templates are reusable mini-apps your agents create with <code>pane template create</code>. Once an agent saves one, it lives here — installs from the public catalog appear below.</p>
          <div class="empty-state-cta"><a class="btn ghost" href="/apps">Browse apps</a></div>
        </div>`
      : `<ul class="list">${templates
          .map((t) => {
            const title = escapeHtml(t.name ?? t.slug ?? t.id);
            const desc = t.description
              ? escapeHtml(t.description)
              : "<em>no description</em>";
            const statusPill = t.publishedAt
              ? `<span class="pill good">Published · ${t.installCount} installs</span>`
              : `<span class="pill muted">Private</span>`;
            const scopesCsv = ((t.scopes as string[] | null) ?? []).join(", ");
            const btnLabel = t.publishedAt ? "Unpublish" : "Publish to catalog";
            const btnAct = t.publishedAt ? "unpublish" : "publish";
            return `<li data-template-id="${escapeHtml(t.id)}" data-published="${t.publishedAt ? "1" : "0"}">
              <div style="min-width:0;flex:1;">
                <div class="title">${title}</div>
                <div class="meta">${desc} · ${escapeHtml(t.shape)}</div>
                <details class="pub-form" style="margin-top:6px;">
                  <summary style="cursor:pointer;font-size:13px;color:var(--accent);">${btnLabel}</summary>
                  <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">
                    <label style="font-size:12.5px;color:var(--muted);">Scopes (comma-separated, e.g. <code>read:agent, write:pane</code>)</label>
                    <textarea class="scopes" rows="2" style="width:100%;border:1px solid var(--rule);border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;" placeholder="leave blank to keep current scopes">${escapeHtml(scopesCsv)}</textarea>
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
                    if (errBody && errBody.error && errBody.error.message) detail = errBody.error.message;
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
  const body = `<h1>My templates</h1>
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
// GET /apps — public catalog browse page (#279).
// Human-facing wrapper over GET /v1/templates/public + install/uninstall.
// UI uses "Apps" vocabulary; the underlying noun stays "template".
// ----------------------------------------------------------------------
systemPages.get("/apps", (c) => {
  const human = c.get("human");
  if (!human) {
    return c.html(
      layout({ title: "Apps", email: null, body: loggedOutPrompt() }),
    );
  }
  const body = `<h1>Apps</h1>
  <p style="color:var(--muted);font-size:14.5px;">Mini apps published by other agents. Install one to make it available to your own agents — they can then create panes from it for you.</p>
  <div class="card">
    <input id="apps-search" type="text" placeholder="Search apps by name, description, or tag" autocomplete="off" />
    <div id="apps-results" style="margin-top:14px;"></div>
  </div>
  <script>
    const resultsEl = document.getElementById("apps-results");
    const searchEl = document.getElementById("apps-search");

    function escape(s) {
      return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function renderItems(items, query) {
      if (!items.length) {
        // Two empty states: search-miss (user typed something) vs. an empty
        // catalog on first load. Different copy, different CTA.
        if (query) {
          resultsEl.innerHTML = '<p class="empty">No apps match "' + escape(query) + '". Try fewer or different keywords.</p>';
        } else {
          resultsEl.innerHTML = '<div class="empty-state">'
            + '<svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/></svg>'
            + '<h3 class="empty-state-headline">The public catalog is empty</h3>'
            + '<p class="empty-state-body">Once agents publish templates with <code>pane template publish &lt;id-or-slug&gt;</code>, the marketplace appears here. Your own authored templates live on <a href="/my-templates">My templates</a>.</p>'
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
          resultsEl.textContent = 'Failed to load apps (' + res.status + ').';
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
    layout({ title: "Apps", email: human.email, body, active: "apps" }),
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
        ? `<div class="empty-state">
          <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V5"/><circle cx="12" cy="3.6" r="1.4"/><circle cx="9" cy="13" r=".8" fill="currentColor"/><circle cx="15" cy="13" r=".8" fill="currentColor"/></svg>
          <h3 class="empty-state-headline">No claimed agents yet</h3>
          <p class="empty-state-body">Use the Generate claim code button above, then run <code>pane agent claim &lt;code&gt;</code> on the agent's machine. Each claim binds an existing agent key to your account — it doesn't replace the key.</p>
        </div>`
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
