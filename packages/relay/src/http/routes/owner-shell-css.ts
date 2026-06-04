// Verbatim CSS extracted from the owner-shell prototype at
// /tmp/demo-template.html (the design source of truth — the user signed
// off on it at /panes/pan_J5ZUOt_xL7UbZDNZ). Kept in its own module so
// /home's route handler stays readable; this file is only the look.
//
// The CSS uses the dark navy palette + brand gradient from the prototype.
// Light-mode users get the same dark UI — the SPA's surface colors
// (--bg / --surface / --ink) are baked dark, matching the prototype's
// always-dark presentation. The system-page sign-in form below stays
// on its own light-aware shell.

export const OWNER_SHELL_CSS = `
  :root {
    /* core surface */
    --bg:        #0a0d14;
    --bg-2:      #0e1320;
    --surface:   #131826;
    --surface-2: #1a2030;
    --surface-3: #232b3e;
    --hairline:  #232b3e;
    --hairline-2: #2f3a51;

    /* ink */
    --ink:        #e8eef9;
    --ink-dim:    #9aa6bc;
    --ink-mute:   #6c7990;

    /* brand */
    --brand-1:   #93c5fd; /* cool blue */
    --brand-2:   #c4b5fd; /* lilac */
    --brand-3:   #5eead4; /* mint */
    --brand-grad: linear-gradient(135deg, var(--brand-1) 0%, var(--brand-2) 60%, var(--brand-3) 110%);

    /* status */
    --green:  #6ee7b7;
    --amber:  #fcd34d;
    --pink:   #fb7185;
    --orange: #fb923c;
    --blue:   #60a5fa;

    --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;

    --radius-card: 16px;
    --radius-tile: 18px;
    --radius-pill: 999px;

    --shadow-soft: 0 8px 30px rgba(0, 0, 0, 0.35);
    --shadow-pop:  0 14px 40px rgba(0, 0, 0, 0.55);

    /* safe areas (PWA) */
    --safe-top:    env(safe-area-inset-top, 0);
    --safe-bottom: env(safe-area-inset-bottom, 0);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  html, body { height: 100%; overflow: hidden; }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 999px; }
  ::-webkit-scrollbar-track { background: transparent; }

  button { font-family: inherit; }
  a { color: inherit; text-decoration: none; }

  /* ============== App shell layout ============== */
  .app {
    position: fixed; inset: 0;
    display: grid;
    grid-template-columns: 220px 1fr;
    grid-template-rows: 1fr;
  }
  @media (max-width: 639px) {
    /* Single full-height content row; the nav becomes a fixed bottom bar
       (out of flow), so it no longer needs a grid track. */
    .app { grid-template-columns: 1fr; grid-template-rows: 1fr; }
  }

  /* ============== Sidebar (desktop) / bottom nav (mobile) ============== */
  .nav {
    background: var(--bg-2);
    border-right: 1px solid var(--hairline);
    display: flex; flex-direction: column;
    padding-top: calc(16px + var(--safe-top));
  }
  .nav .brand {
    padding: 0 18px 18px;
    display: flex; align-items: center; gap: 10px;
    font-weight: 700; font-size: 17px;
    letter-spacing: -0.01em;
  }
  .nav .brand .logo {
    width: 28px; height: 28px; border-radius: 7px;
    background: var(--brand-grad);
    display: flex; align-items: center; justify-content: center;
    color: #07090f; font-weight: 800; font-size: 13px;
    box-shadow: var(--shadow-soft);
  }
  .nav .brand .name {
    background: var(--brand-grad);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }

  .nav .items { list-style: none; padding: 6px; margin: 0; display: flex; flex-direction: column; gap: 2px; flex: 1; }
  .nav .items li button {
    width: 100%;
    background: transparent;
    border: none;
    border-radius: 10px;
    padding: 9px 12px;
    color: var(--ink-dim);
    font-size: 14px;
    display: flex; align-items: center; gap: 10px;
    cursor: pointer;
    transition: background 100ms, color 100ms;
    text-align: left;
  }
  .nav .items li button:hover { background: var(--surface); color: var(--ink); }
  .nav .items li button.active {
    background: var(--surface);
    color: var(--ink);
  }
  .nav .items li button.active::before {
    content: ''; width: 3px; height: 18px;
    background: var(--brand-grad);
    border-radius: 2px;
    margin-right: 2px;
    margin-left: -8px;
  }
  .nav .items li button .icon {
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    color: currentColor;
  }
  .nav .items li button .count {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-mute);
    background: var(--surface-2);
    padding: 1px 7px;
    border-radius: 999px;
  }

  .nav .me {
    padding: 12px 14px calc(14px + var(--safe-bottom));
    border-top: 1px solid var(--hairline);
    display: flex; align-items: center; gap: 10px;
  }
  .nav .me .avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: var(--brand-grad);
    display: flex; align-items: center; justify-content: center;
    color: #07090f; font-weight: 700; font-size: 13px;
    flex: none;
  }
  .nav .me .who { font-size: 13px; line-height: 1.2; }
  .nav .me .who .name { color: var(--ink); font-weight: 500; }
  .nav .me .who .sub  { color: var(--ink-mute); font-size: 11px; }
  /* Account controls. Desktop: an inline icon row pushed to the right of the
     footer, after the avatar + identity. The mobile "Account" trigger tab is
     hidden here; labels are hidden (icon-only). */
  .nav .me .acct-tab { display: none; }
  .nav .me .acct-links { margin-left: auto; display: flex; align-items: center; gap: 2px; }
  .nav .me .acct-link {
    background: transparent; border: none; cursor: pointer;
    color: var(--ink-mute); font: inherit; text-decoration: none;
    padding: 6px; border-radius: 6px;
    display: inline-flex; align-items: center; gap: 10px;
  }
  .nav .me .acct-link:hover { background: var(--surface); color: var(--ink); }
  .nav .me .acct-link .ico { display: inline-flex; }
  .nav .me .acct-link .txt { display: none; }

  @media (max-width: 639px) {
    /* Fixed bottom bar — same model as the system-pages bottom-tabs nav, so
       the tab strip sits flush above the home indicator and matches every
       other page. (Previously a grid row inside the fixed inset:0 app shell,
       which left a gap above the home indicator on devices with a tall bottom
       safe area, e.g. iPhone 14 Pro Max.) */
    .nav {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
      border-right: none; border-top: 1px solid var(--hairline);
      background: color-mix(in srgb, var(--bg-2) 92%, transparent);
      -webkit-backdrop-filter: saturate(180%) blur(14px);
      backdrop-filter: saturate(180%) blur(14px);
      flex-direction: row;
      align-items: stretch;
      justify-content: space-around;
      padding: 6px max(8px, env(safe-area-inset-left)) calc(6px + var(--safe-bottom)) max(8px, env(safe-area-inset-right));
    }
    .nav .brand { display: none; }
    /* The footer's full-page links (/my-agents, /settings) and sign-out have
       no other entry point. On mobile, collapse them behind a single "Account"
       tab in the bottom bar that toggles a popover sheet — rather than cramming
       three bare icons next to the four labelled tabs. The bar then reads as
       five even columns. */
    .nav .me {
      flex: 1;
      position: relative;
      border-top: none;
      padding: 0;
      gap: 0;
      align-items: stretch;
    }
    .nav .me .avatar, .nav .me .who { display: none; }
    .nav .me .acct-tab {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 3px; width: 100%; min-height: 52px;
      background: transparent; border: none; cursor: pointer;
      color: var(--ink-dim); font-size: 11px;
      padding: 8px 4px 4px;
    }
    .nav .me .acct-tab .icon {
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
    }
    .nav .me.open .acct-tab { color: var(--brand-1); }
    /* The desktop inline link row becomes a popover sheet above the bar. */
    .nav .me .acct-links {
      display: none;
      position: absolute;
      bottom: calc(100% + 8px);
      right: 8px;
      margin: 0;
      min-width: 204px;
      flex-direction: column;
      gap: 2px;
      padding: 6px;
      background: var(--bg-2);
      border: 1px solid var(--hairline);
      border-radius: 12px;
      box-shadow: var(--shadow-soft);
      z-index: 50;
    }
    .nav .me.open .acct-links { display: flex; }
    .nav .me .acct-link {
      width: 100%;
      gap: 12px;
      padding: 11px 12px;
      border-radius: 8px;
      color: var(--ink-dim);
      font-size: 14px;
      text-align: left;
    }
    .nav .me .acct-link:hover, .nav .me .acct-link:active { background: var(--surface); color: var(--ink); }
    .nav .me .acct-link .txt { display: inline; }
    .nav .items {
      flex-direction: row;
      flex: 4;
      padding: 0;
      gap: 0;
    }
    .nav .items li { flex: 1; }
    .nav .items li button {
      flex-direction: column;
      justify-content: center;
      gap: 3px;
      padding: 8px 4px 4px;
      min-height: 52px;
      font-size: 11px;
      text-align: center;
      border-radius: 8px;
    }
    .nav .items li button.active::before { display: none; }
    .nav .items li button.active { background: transparent; color: var(--brand-1); }
    .nav .items li button .count { display: none; }
  }

  /* ============== Main view container ============== */
  .main {
    overflow-y: auto;
    overflow-x: hidden;
    padding-top: var(--safe-top);
  }
  .view { display: none; padding: 22px 26px 40px; max-width: 1200px; margin: 0 auto; }
  .view.active { display: block; animation: fadeIn 240ms cubic-bezier(.22,.61,.36,1); }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (max-width: 639px) {
    /* Reserve space for the fixed bottom nav (~52px tab + 12px padding) plus
       the home-indicator safe area, so content can scroll clear of the bar. */
    .view { padding: 14px 16px calc(28px + 64px + var(--safe-bottom)); }
  }

  .view-head {
    display: flex; align-items: end; justify-content: space-between;
    gap: 12px;
    margin-bottom: 18px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--hairline);
  }
  .view-head h1 {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }
  .view-head .sub {
    margin-top: 4px;
    font-size: 13px;
    color: var(--ink-mute);
  }
  .view-head .actions { display: flex; gap: 8px; }

  /* ============== Top-level controls (search + profile) ============== */
  .search {
    position: relative;
    width: 100%;
    max-width: 460px;
  }
  .search input {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 10px;
    padding: 9px 12px 9px 34px;
    color: var(--ink);
    font-size: 14px;
    font-family: inherit;
  }
  .search input:focus { outline: none; border-color: var(--brand-1); }
  .search .icon {
    position: absolute; left: 10px; top: 50%;
    transform: translateY(-50%);
    color: var(--ink-mute);
    pointer-events: none;
  }
  .search input::placeholder { color: var(--ink-mute); }

  /* ============== HOME screen ============== */
  .greet {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .greet .name {
    background: var(--brand-grad);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .greet-sub { color: var(--ink-mute); font-size: 13px; margin-bottom: 22px; }

  .section { margin-top: 28px; }
  .section-head {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 10px;
  }
  .section-head h2 {
    font-size: 13px;
    color: var(--ink-mute);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    margin: 0;
  }
  .section-head a {
    font-size: 12px;
    color: var(--brand-1);
    cursor: pointer;
  }
  .section-head a:hover { text-decoration: underline; }

  /* Favorites strip (horizontal scroll) */
  .favs {
    display: flex; gap: 12px;
    overflow-x: auto;
    padding: 4px 2px 12px;
    margin: 0 -2px;
    scrollbar-width: thin;
  }
  .fav-tile {
    flex: 0 0 96px;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    cursor: pointer;
    user-select: none;
  }
  .fav-tile .icon {
    width: 76px; height: 76px;
    border-radius: var(--radius-tile);
    display: flex; align-items: center; justify-content: center;
    color: #07090f;
    font-size: 32px;
    font-weight: 700;
    box-shadow: var(--shadow-soft);
    transition: transform 200ms cubic-bezier(.22,.61,.36,1);
    position: relative;
  }
  .fav-tile:hover .icon { transform: translateY(-3px) scale(1.04); }
  .fav-tile:active .icon { transform: translateY(-1px) scale(0.97); }
  .fav-tile .label {
    font-size: 12px; color: var(--ink-dim);
    text-align: center;
    max-width: 96px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .fav-tile .badge {
    position: absolute; top: -5px; right: -5px;
    background: var(--pink);
    color: #07090f;
    font-weight: 700; font-size: 10px;
    border-radius: 999px;
    padding: 1px 6px;
    min-width: 18px;
    text-align: center;
    border: 2px solid var(--bg);
  }

  /* Recent panes — horizontal scroll cards */
  .recents {
    display: flex; gap: 14px;
    overflow-x: auto;
    padding: 4px 2px 12px;
    margin: 0 -2px;
    scrollbar-width: thin;
  }
  .recent-card {
    flex: 0 0 280px;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-card);
    padding: 12px;
    display: flex; flex-direction: column; gap: 10px;
    cursor: pointer;
    transition: border-color 150ms, transform 150ms;
  }
  .recent-card:hover { border-color: var(--hairline-2); transform: translateY(-2px); }
  .recent-card .thumb {
    height: 100px;
    border-radius: 10px;
    background: var(--surface-2);
    position: relative;
    overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }
  .recent-card .thumb .glyph {
    font-size: 32px;
    color: #07090f;
    font-weight: 800;
  }
  .recent-card .thumb .tag {
    position: absolute; bottom: 6px; left: 8px;
    font-family: var(--mono); font-size: 10px;
    background: rgba(0,0,0,0.45);
    color: var(--ink);
    padding: 1px 6px; border-radius: 4px;
  }
  .recent-card .title { font-weight: 600; font-size: 13.5px; }
  .recent-card .meta {
    display: flex; justify-content: space-between;
    color: var(--ink-mute); font-size: 11.5px;
    font-family: var(--mono);
  }

  /* Apps grid (Launchpad-style) */
  .apps-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 18px 12px;
    margin-top: 4px;
  }
  .app-tile {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    cursor: pointer;
    user-select: none;
    padding: 4px;
    border-radius: 10px;
    transition: background 100ms;
    position: relative;
  }
  .app-tile:hover { background: rgba(255,255,255,0.02); }
  .app-tile .icon {
    width: 64px; height: 64px;
    border-radius: 16px;
    display: flex; align-items: center; justify-content: center;
    color: #07090f;
    font-size: 26px;
    font-weight: 700;
    box-shadow: var(--shadow-soft);
    transition: transform 200ms;
  }
  .app-tile:hover .icon { transform: scale(1.05); }
  .app-tile .label {
    font-size: 11.5px;
    text-align: center;
    color: var(--ink-dim);
    max-width: 88px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.3;
  }
  .app-tile .star {
    position: absolute; top: 2px; right: 8px;
    color: var(--amber);
    font-size: 12px;
    opacity: 0;
    transition: opacity 100ms;
  }
  .app-tile.favorited .star { opacity: 1; }

  /* Category sub-headers in apps view */
  .cat-row {
    margin: 26px 0 10px;
    display: flex; align-items: center; gap: 8px;
  }
  .cat-row h3 {
    margin: 0;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-mute);
    font-weight: 600;
  }
  .cat-row .count {
    font-family: var(--mono); font-size: 11px;
    color: var(--ink-mute);
    background: var(--surface);
    padding: 1px 7px; border-radius: 999px;
  }

  /* ============== Panes (sessions) list ============== */
  .panes-list {
    list-style: none; padding: 0; margin: 0;
    display: flex; flex-direction: column; gap: 8px;
  }
  .pane-row {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 12px;
    padding: 12px 14px;
    display: grid;
    grid-template-columns: 44px 1fr auto auto auto;
    gap: 14px;
    align-items: center;
    cursor: pointer;
    transition: border-color 150ms;
  }
  .pane-row:hover { border-color: var(--hairline-2); }
  .pane-row .icon {
    width: 44px; height: 44px;
    border-radius: 11px;
    display: flex; align-items: center; justify-content: center;
    color: #07090f; font-weight: 700; font-size: 17px;
    flex: none;
  }
  .pane-row .info { min-width: 0; }
  .pane-row .info .title {
    font-weight: 600; font-size: 14px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pane-row .info .meta {
    color: var(--ink-mute); font-size: 12px;
    font-family: var(--mono);
    margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pane-row .status {
    font-family: var(--mono); font-size: 11px;
    padding: 2px 8px; border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pane-row .status.open    { background: rgba(110, 231, 183, 0.1); color: var(--green); }
  .pane-row .status.closed  { background: var(--surface-2); color: var(--ink-mute); }
  .pane-row .status.expiring { background: rgba(252, 211, 77, 0.1); color: var(--amber); }
  .pane-row .menu-btn {
    width: 28px; height: 28px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--ink-mute);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .pane-row .menu-btn:hover { background: var(--surface-2); border-color: var(--hairline); color: var(--ink); }

  /* ============== Trash ============== */
  .trash-list { list-style: none; padding: 0; margin: 0; }
  .trash-list li {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 10px;
    padding: 10px 14px;
    margin-bottom: 8px;
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
  }
  .trash-list .name { font-size: 13.5px; color: var(--ink-dim); }
  .trash-list .when { font-family: var(--mono); font-size: 11px; color: var(--ink-mute); }
  .trash-actions { display: flex; gap: 6px; }

  /* ============== Generic buttons ============== */
  .btn {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    color: var(--ink-dim);
    padding: 6px 12px;
    font-size: 12.5px;
    cursor: pointer;
    transition: color 100ms, border-color 100ms;
  }
  .btn:hover { color: var(--ink); border-color: var(--hairline-2); }
  .btn.primary {
    background: var(--brand-grad);
    color: #07090f;
    border-color: transparent;
    font-weight: 600;
  }
  .btn.primary:hover { filter: brightness(1.08); color: #07090f; }
  .btn.danger { color: var(--pink); border-color: rgba(251, 113, 133, 0.3); }
  .btn.danger:hover { background: rgba(251, 113, 133, 0.08); color: var(--pink); border-color: var(--pink); }
  .btn.small { padding: 4px 10px; font-size: 11.5px; }

  /* ============== Context menu (right-click / long-press) ============== */
  .ctx {
    position: fixed;
    min-width: 220px;
    background: var(--surface);
    border: 1px solid var(--hairline-2);
    border-radius: 10px;
    box-shadow: var(--shadow-pop);
    padding: 6px;
    z-index: 200;
    display: none;
    animation: ctxIn 120ms cubic-bezier(.22,.61,.36,1);
  }
  .ctx.open { display: block; }
  @keyframes ctxIn {
    from { opacity: 0; transform: scale(0.95); }
    to   { opacity: 1; transform: scale(1); }
  }
  .ctx-item {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--ink);
    font-size: 13px;
  }
  .ctx-item:hover { background: var(--surface-2); }
  .ctx-item.danger { color: var(--pink); }
  .ctx-item.danger:hover { background: rgba(251, 113, 133, 0.08); }
  .ctx-item .ic {
    width: 16px; height: 16px;
    display: flex; align-items: center; justify-content: center;
    color: var(--ink-mute);
  }
  .ctx-item .kbd {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-mute);
  }
  .ctx-separator {
    height: 1px;
    background: var(--hairline);
    margin: 4px 0;
  }

  /* ============== Modal sheet ============== */
  .sheet-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(6px);
    display: none;
    align-items: center; justify-content: center;
    z-index: 150;
    animation: sheetBackIn 200ms cubic-bezier(.22,.61,.36,1);
  }
  .sheet-backdrop.open { display: flex; }
  @keyframes sheetBackIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .sheet {
    background: var(--surface);
    border: 1px solid var(--hairline-2);
    border-radius: 16px;
    width: calc(100% - 32px);
    max-width: 640px;
    max-height: calc(100vh - 32px);
    overflow: auto;
    box-shadow: var(--shadow-pop);
    animation: sheetIn 240ms cubic-bezier(.22,.61,.36,1);
  }
  @keyframes sheetIn {
    from { transform: translateY(40px) scale(0.96); opacity: 0; }
    to   { transform: translateY(0) scale(1); opacity: 1; }
  }
  .sheet > header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--hairline);
    display: flex; align-items: center; gap: 14px;
  }
  .sheet > header .icon {
    width: 48px; height: 48px;
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    color: #07090f; font-size: 22px; font-weight: 700;
    flex: none;
  }
  .sheet > header .title { font-size: 17px; font-weight: 700; line-height: 1.2; }
  .sheet > header .sub   { font-size: 12px; color: var(--ink-mute); margin-top: 2px; font-family: var(--mono); }
  .sheet > header .close {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--hairline);
    border-radius: 8px;
    width: 30px; height: 30px;
    color: var(--ink-mute);
    cursor: pointer;
    flex: none;
  }
  .sheet > header .close:hover { color: var(--ink); border-color: var(--hairline-2); }

  .sheet .body { padding: 18px 20px; }
  .sheet .row {
    display: flex; gap: 16px; flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .sheet .field { flex: 1; min-width: 140px; }
  .sheet label {
    display: block; font-size: 11px; color: var(--ink-mute);
    text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px;
  }
  .sheet input, .sheet select, .sheet textarea {
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 8px;
    padding: 7px 10px;
    color: var(--ink);
    font-family: inherit;
    font-size: 13px;
  }
  .sheet input:focus, .sheet select:focus, .sheet textarea:focus { outline: none; border-color: var(--brand-1); }

  .sheet .panes-mini { list-style: none; padding: 0; margin: 0; }
  .sheet .panes-mini li {
    padding: 8px 12px;
    background: var(--surface-2);
    border-radius: 8px;
    margin-bottom: 4px;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 13px;
  }
  .sheet .panes-mini .title { color: var(--ink); }
  .sheet .panes-mini .when  { color: var(--ink-mute); font-family: var(--mono); font-size: 11px; }
  .sheet .versions { list-style: none; padding: 0; margin: 0; }
  .sheet .versions li {
    padding: 8px 12px;
    background: var(--surface-2);
    border-radius: 8px;
    margin-bottom: 4px;
    display: flex; justify-content: space-between; align-items: center;
    font-family: var(--mono); font-size: 12.5px;
  }
  .sheet .versions .v-badge {
    background: var(--surface-3);
    padding: 1px 6px; border-radius: 4px;
    color: var(--brand-1);
  }
  .sheet section {
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px dashed var(--hairline);
  }
  .sheet section h4 {
    margin: 0 0 10px;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-mute);
  }
  .sheet .actions {
    display: flex; gap: 8px; margin-top: 18px;
    flex-wrap: wrap;
  }
  .sheet .actions .danger { margin-left: auto; }

  /* ============== Toast ============== */
  .toast-wrap {
    position: fixed;
    bottom: calc(20px + var(--safe-bottom));
    left: 50%; transform: translateX(-50%);
    z-index: 300;
    display: flex; flex-direction: column; gap: 8px;
    pointer-events: none;
  }
  @media (max-width: 639px) {
    .toast-wrap { bottom: calc(80px + var(--safe-bottom)); }
  }
  .toast {
    background: var(--surface);
    border: 1px solid var(--hairline-2);
    border-radius: 10px;
    padding: 9px 14px;
    font-size: 13px;
    color: var(--ink);
    box-shadow: var(--shadow-pop);
    animation: toastIn 220ms cubic-bezier(.22,.61,.36,1), toastOut 220ms 3.5s cubic-bezier(.22,.61,.36,1) forwards;
    display: flex; align-items: center; gap: 8px;
  }
  .toast .ic { color: var(--brand-1); font-weight: 700; }
  @keyframes toastIn {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes toastOut {
    from { opacity: 1; transform: translateY(0); }
    to   { opacity: 0; transform: translateY(14px); }
  }

  /* ============== "Single-row pane chrome" mockup view ============== */
  .chrome-demo {
    background: var(--bg-2);
    border: 1px solid var(--hairline);
    border-radius: 14px;
    padding: 0;
    overflow: hidden;
    margin-top: 12px;
  }
  .chrome-demo .label {
    padding: 10px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--hairline);
    font-size: 12px;
    color: var(--ink-mute);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .chrome-demo .label.bad { color: var(--pink); }
  .chrome-demo .label.good { color: var(--green); }

  /* Bad current chrome (two rows) */
  .chrome-bad {
    background: #fff;
    color: #0a0d14;
  }
  .chrome-bad .row1 {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid #e7e9ef;
    font-size: 13px;
  }
  .chrome-bad .row1 .tabs { display: flex; gap: 14px; }
  .chrome-bad .row1 .tabs a { color: #5d6577; }
  .chrome-bad .row1 .tabs a.active { color: #6d5ef0; font-weight: 600; }
  .chrome-bad .row2 {
    padding: 12px 16px;
    display: flex; align-items: center; gap: 10px;
    border-bottom: 1px solid #e7e9ef;
  }
  .chrome-bad .row2 .pane-title { font-weight: 600; }
  .chrome-bad .row2 .pane-id { color: #5d6577; font-family: var(--mono); font-size: 12px; margin-left: 10px; }
  .chrome-bad .iframe-area {
    height: 120px;
    background: #f6f7f9;
    display: flex; align-items: center; justify-content: center;
    color: #98a4ba;
    font-style: italic;
    font-size: 13px;
  }

  /* Good redesigned chrome (single row) */
  .chrome-good {
    background: #fff;
    color: #0a0d14;
  }
  .chrome-good .one-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 14px;
    align-items: center;
    padding: 9px 14px;
    border-bottom: 1px solid #e7e9ef;
  }
  .chrome-good .left {
    display: flex; align-items: center; gap: 12px;
  }
  .chrome-good .back {
    width: 28px; height: 28px; border-radius: 8px;
    background: #f6f7f9;
    border: 1px solid #e7e9ef;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    color: #5d6577;
  }
  .chrome-good .icon-mini {
    width: 26px; height: 26px;
    border-radius: 7px;
    background: linear-gradient(135deg, #93c5fd, #c4b5fd);
    color: #07090f; font-weight: 700; font-size: 12px;
    display: flex; align-items: center; justify-content: center;
  }
  .chrome-good .breadcrumb {
    font-size: 13px;
    color: #5d6577;
  }
  .chrome-good .breadcrumb b { color: #0a0d14; font-weight: 600; margin-left: 4px; }
  .chrome-good .breadcrumb .sep { margin: 0 6px; color: #c4c9d4; }
  .chrome-good .center {
    text-align: center;
    color: #5d6577;
    font-size: 12px;
    font-family: var(--mono);
  }
  .chrome-good .center .dot { color: #6ee7b7; }
  .chrome-good .right {
    display: flex; align-items: center; gap: 6px;
  }
  .chrome-good .icon-btn {
    width: 30px; height: 30px;
    background: #f6f7f9;
    border: 1px solid #e7e9ef;
    border-radius: 8px;
    color: #5d6577;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .chrome-good .icon-btn:hover { background: #ecedf0; color: #0a0d14; }
  .chrome-good .iframe-area {
    height: 120px;
    background: #f6f7f9;
    display: flex; align-items: center; justify-content: center;
    color: #98a4ba;
    font-style: italic;
    font-size: 13px;
  }

  /* feedback banner */
  .banner {
    background: var(--surface);
    border: 1px solid var(--brand-1);
    border-radius: 12px;
    padding: 12px 16px;
    margin-top: 14px;
    display: flex; align-items: start; gap: 12px;
    font-size: 13px;
    color: var(--ink-dim);
    line-height: 1.5;
  }
  .banner .ic {
    width: 22px; height: 22px; flex: none;
    border-radius: 6px;
    background: var(--brand-grad);
    color: #07090f; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px;
  }
  .banner b { color: var(--ink); font-weight: 600; }
  .banner code {
    font-family: var(--mono); font-size: 12px;
    background: rgba(255,255,255,0.05);
    padding: 1px 5px; border-radius: 3px; color: var(--brand-1);
  }

  /* ----- Template / pane icons -----
   * Each .icon box (fav-tile, app-tile, pane-row) is now a neutral square
   * container; its inner element decides the look. Render order is
   * image → emoji → gradient monogram (the always-works fallback). All three
   * inner variants fill the box and inherit its border-radius so swapping the
   * source never changes the tile's silhouette. */
  .tile-img,
  .tile-emoji,
  .tile-monogram {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    border-radius: inherit;
    overflow: hidden;
  }
  /* Uploaded raster image — cover the square, rounded to match the box. */
  .tile-img {
    object-fit: cover;
    display: block;
  }
  /* Emoji — centered glyph on a subtle neutral background so a transparent
   * emoji still reads against the page. Slightly smaller than the box so the
   * glyph isn't clipped by the rounded corners. */
  .tile-emoji {
    background: var(--surface-2);
    line-height: 1;
    /* Scale the emoji to the box; em is relative to the box's font-size,
     * which each context sets on .icon (32 / 26 / 17px). */
    font-size: 0.92em;
  }
  /* Gradient monogram — the inline background (per-seed hue) is set on the
   * element itself; this just lays out the initials. */
  .tile-monogram {
    color: #07090f;
    font-weight: 700;
    line-height: 1;
  }

  /* ============== Agent-init instructions modal ============== */
  .ai-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .ai-modal[hidden] { display: none; }
  .ai-modal-backdrop { position: absolute; inset: 0; background: rgba(4, 6, 10, 0.66); backdrop-filter: blur(2px); }
  .ai-modal-card {
    position: relative; z-index: 1; width: 100%; max-width: 520px;
    max-height: calc(100% - 32px); overflow-y: auto;
    background: var(--bg-2); border: 1px solid var(--hairline);
    border-radius: 16px; padding: 22px 22px 18px;
    box-shadow: 0 24px 70px rgba(0,0,0,0.5);
  }
  .ai-modal-x {
    position: absolute; top: 12px; right: 12px;
    background: transparent; border: none; color: var(--ink-mute);
    cursor: pointer; padding: 6px; border-radius: 8px; line-height: 0;
  }
  .ai-modal-x:hover { background: var(--surface); color: var(--ink); }
  .ai-modal-head { display: flex; align-items: center; gap: 10px; margin: 0 28px 10px 0; }
  .ai-modal-badge {
    display: inline-flex; align-items: center; gap: 5px; flex: none;
    font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
    color: #c9a8ff; background: rgba(168, 85, 247, 0.16);
    border: 1px solid rgba(168, 85, 247, 0.34);
    padding: 3px 9px; border-radius: 999px;
  }
  .ai-modal-head h2 { margin: 0; font-size: 17px; color: var(--ink); line-height: 1.3; }
  .ai-modal-lead { margin: 0 0 14px; color: var(--ink-dim); font-size: 13.5px; line-height: 1.5; }
  .ai-modal-lead code { font-family: var(--mono); font-size: 12px; background: rgba(255,255,255,0.05); padding: 1px 5px; border-radius: 3px; color: var(--brand-1); }
  .ai-modal-instr { position: relative; }
  .ai-modal-instr pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.55; color: var(--ink);
    background: var(--bg); border: 1px solid var(--hairline);
    border-radius: 10px; padding: 14px 14px 14px; padding-right: 64px;
  }
  .ai-modal-copy {
    position: absolute; top: 8px; right: 8px;
    background: var(--surface-2); border: 1px solid var(--hairline);
    color: var(--ink); cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
    padding: 5px 12px; border-radius: 7px; min-height: 30px;
  }
  .ai-modal-copy:hover { background: var(--surface); }
  .ai-modal-copy.copied { color: var(--brand-1); border-color: var(--brand-1); }
  .ai-modal-foot { margin: 12px 0 0; color: var(--ink-mute); font-size: 12.5px; }
`;
