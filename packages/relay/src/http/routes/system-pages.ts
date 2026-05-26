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

// Shared layout primitives — every system page wraps its body in this
// shell so the visual identity is uniform.
function layout(args: {
  title: string;
  email: string | null;
  body: string;
  /** Slug of the current page (e.g. "home"). Highlights the nav link. */
  active?: string;
}): string {
  const nav = (slug: string, label: string, href: string) => {
    const isActive = args.active === slug;
    const style = isActive
      ? "color:var(--accent);font-weight:600;"
      : "color:var(--muted);";
    return `<a href="${href}" style="${style}text-decoration:none;font-size:14px;padding:6px 10px;border-radius:6px;">${escapeHtml(label)}</a>`;
  };
  const accountBlock = args.email
    ? `<span style="font-size:13px;color:var(--muted);">${escapeHtml(args.email)}</span>
       <button id="pane-logout" style="background:none;border:1px solid var(--rule);color:var(--muted);font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer;">Sign out</button>`
    : `<a href="/login" style="color:var(--accent);font-size:14px;text-decoration:none;">Sign in</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(args.title)} · pane</title>
<style>
  :root {
    --bg: #fafaf9;
    --panel: #fff;
    --fg: #1a1a1a;
    --muted: #6b6b6b;
    --rule: #e6e3df;
    --accent: #b34700;
    --accent-soft: #fff4ec;
    --code-bg: #f3f0eb;
    --good: #2a6f3f;
    --good-soft: #e9f1ec;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; font-size: 16px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  header.pane-nav { border-bottom: 1px solid var(--rule); padding: 14px 28px; display: flex; align-items: center; gap: 22px; background: #fff; }
  header.pane-nav .brand { font-weight: 700; font-size: 15px; letter-spacing: -0.01em; margin-right: 8px; }
  header.pane-nav .links { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
  header.pane-nav .account { display: flex; align-items: center; gap: 10px; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 28px 80px; }
  h1 { font-size: 26px; letter-spacing: -0.012em; margin: 0 0 18px; }
  h2 { font-size: 18px; margin: 28px 0 10px; }
  p { margin: 0 0 14px; }
  .card { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 20px 22px; margin-bottom: 14px; }
  .list { list-style: none; padding: 0; margin: 0; }
  .list li { padding: 12px 0; border-bottom: 1px solid var(--rule); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .list li:last-child { border-bottom: none; }
  .list li .title { font-weight: 600; }
  .list li .meta { font-size: 13px; color: var(--muted); }
  .empty { color: var(--muted); padding: 20px 0; text-align: center; }
  button.btn, a.btn { font: inherit; font-size: 14px; font-weight: 600; padding: 8px 14px; border-radius: 8px; cursor: pointer; border: none; background: var(--fg); color: #fff; text-decoration: none; display: inline-block; }
  button.btn:hover, a.btn:hover { background: #000; }
  button.btn.ghost, a.btn.ghost { background: transparent; color: var(--fg); border: 1px solid var(--rule); }
  input[type=email], input[type=text] { font: inherit; font-size: 15px; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 8px; background: #fff; color: var(--fg); width: 100%; outline: none; }
  input[type=email]:focus, input[type=text]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  code { font-family: "SF Mono",Menlo,Consolas,monospace; font-size: 13.5px; background: var(--code-bg); padding: 1px 6px; border-radius: 3px; }
  pre { font-family: "SF Mono",Menlo,Consolas,monospace; background: var(--code-bg); padding: 14px 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5; margin: 0 0 14px; }
  .row { display: flex; align-items: center; gap: 10px; }
  .pill { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; }
  .pill.good { background: var(--good-soft); color: var(--good); }
  .pill.muted { background: var(--code-bg); color: var(--muted); }
</style>
</head>
<body>
<header class="pane-nav">
  <div class="brand">pane</div>
  <nav class="links">
    ${nav("home", "Home", "/home")}
    ${nav("surfaces", "My surfaces", "/my-surfaces")}
    ${nav("templates", "My templates", "/my-templates")}
    ${nav("agents", "My agents", "/my-agents")}
    ${nav("settings", "Settings", "/settings")}
  </nav>
  <div class="account">${accountBlock}</div>
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
// GET /login — static login form
// ----------------------------------------------------------------------
systemPages.get("/login", (c) => {
  const provider = c.get("emailProvider");
  const human = c.get("human");
  if (human) {
    // Already signed in — bounce to /home rather than re-prompting.
    return c.redirect("/home", 302);
  }
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
          <label for="email" style="font-size:13px;color:var(--muted);">Email</label>
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
               status.textContent = "Check " + email + " for your sign-in link. It expires in 15 minutes.";
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
            .map(
              (s) =>
                `<li><div><div class="title">${escapeHtml(s.title)}</div><div class="meta"><code>${escapeHtml(s.id)}</code> · ${s.status} · created ${escapeHtml(s.createdAt.toISOString().slice(0, 10))}</div></div>${s.status === "open" ? `<span class="pill good">Open</span>` : `<span class="pill muted">Closed</span>`}</li>`,
            )
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
  // Auto-flow: templates owned by an agent the human has claimed.
  const templates = await prisma.template.findMany({
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
  });
  const body = `<h1>My templates</h1>
  <p style="color:var(--muted);font-size:14.5px;">Templates created by agents you own. Templates from other people that you've installed will appear here too once the public catalog lands.</p>
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
  </div>`;
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
    <div id="code-out" hidden style="background:var(--accent-soft);border:1px solid #f1d6bd;border-radius:8px;padding:14px 16px;">
      <div style="font-size:12px;color:var(--accent);font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">Your code</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <code id="code-value" style="font-size:15px;background:#fff;padding:6px 10px;display:inline-block;border-radius:6px;border:1px solid #f1d6bd;user-select:all;"></code>
        <button id="copy-code" type="button" class="btn ghost" style="padding:6px 12px;font-size:13px;">Copy</button>
      </div>
      <div style="font-size:13px;color:#6b4d2a;margin-top:8px;">Expires in <span id="code-ttl"></span>. Copy now — you won't see it again.</div>
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
