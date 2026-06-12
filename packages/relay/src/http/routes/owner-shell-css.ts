// Verbatim CSS extracted from the owner-shell prototype at
// /tmp/demo-template.html (the design source of truth — the user signed
// off on it at /panes/pan_J5ZUOt_xL7UbZDNZ). Kept in its own module so
// /home's route handler stays readable; this file is only the look.
//
// The CSS uses the "Warm Sunset" palette that matches the marketing site
// (coral #D97757 / amber #E0A23A accents). Light mode is warm-paper
// (--bg #f7f5f1) like the landing page; dark mode is a warm charcoal
// re-tint. Both are driven by prefers-color-scheme below.

import { PREVIEW_FRAME_PX } from "../../bridge/preview-render.js";

// Preview-thumbnail frame geometry (see PREVIEW_FRAME_PX in preview-render.ts):
// the iframe is PREVIEW_FRAME_PX wide and renders the pane's 1000px desktop
// layout into it via `zoom`, so each card just scales the small frame by
// display/PREVIEW_FRAME_PX. Square tiles (favourites, app) use a square frame;
// the 16:11 gallery cards (recents, explore) use a PREVIEW_FRAME_PX*11/16 frame.
const PVF = PREVIEW_FRAME_PX;
const PVF_169 = (PREVIEW_FRAME_PX * 11) / 16; // 16:11 card height in frame px

export const OWNER_SHELL_CSS = `
  :root {
    color-scheme: light dark;
    /* core surface */
    --bg:        #14110d;
    --bg-2:      #1b1611;
    --surface:   #211b14;
    --surface-2: #2a231a;
    --surface-3: #342b20;
    --hairline:  #2a231a;
    --hairline-2: #3a3025;

    /* ink */
    --ink:        #f3ece2;
    --ink-dim:    #c2b6a4;
    --ink-mute:   #968b78;

    /* brand */
    --brand-1:   #f2b49a; /* warm peach */
    --brand-2:   #f4c98c; /* amber */
    --brand-3:   #f6d9a6; /* pale gold */
    --brand-grad: linear-gradient(135deg, var(--brand-1) 0%, var(--brand-2) 60%, var(--brand-3) 110%);

    /* accent — coral, used directly as text/border/link on the page
       background. The light override swaps in the site coral (#D97757) for
       contrast on the warm-paper surface; the gradient stops above stay
       pastel for dark text on the decorative fills. */
    --accent: #e8906b;

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
  /* Light mode — additive override of the structural tokens only. Dark stays
     byte-identical (it is the default :root above). The brand gradient stops
     (--brand-1/2/3, --brand-grad) are intentionally NOT darkened: they are
     decorative fills behind dark (#07090f) text, so they must stay pastel. */
  @media (prefers-color-scheme: light) {
    :root {
      --bg:        #f7f5f1;
      --bg-2:      #ffffff;
      --surface:   #ffffff;
      --surface-2: #faf8f4;
      --surface-3: #efece5;
      --hairline:  #e6e0d6;
      --hairline-2:#d9d2c5;
      --ink:       #1a1726;
      --ink-dim:   #5b5570;
      --ink-mute:  #8b85a0;
      --green:  #059669;
      --amber:  #b45309;
      --pink:   #e11d48;
      --orange: #ea580c;
      --blue:   #2563eb;
      --accent: #D97757;
      --shadow-soft: 0 8px 30px rgba(17,24,39,0.10);
      --shadow-pop:  0 14px 40px rgba(17,24,39,0.18);
    }
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
  /* Height tracks the *dynamic* viewport (100dvh) rather than a fixed
     inset:0 box. On iOS the layout viewport (what position:fixed anchors to)
     is taller than the visible area while the Safari toolbar is shown, so a
     fixed inset:0 shell + a fixed bottom bar left a dead strip below the bar.
     100dvh follows the live visible height, so the bottom row always hugs the
     true visual bottom. 100vh is the fallback for engines without dvh. */
  .app {
    height: 100vh;
    height: 100dvh;
    display: grid;
    grid-template-columns: 220px 1fr;
    grid-template-rows: 1fr;
  }
  /* Installed PWA: pin the shell to the viewport with position:fixed/inset:0
     instead of a vh/dvh *length*. Two device-only iOS quirks make length-based
     sizing lose in standalone mode:
       - 100dvh can be captured SHORTER than the full screen in the app-switcher
         snapshot, exposing the splash/background_color (--bg #f7f5f1) as a dead
         strip below the in-flow bottom tab bar.
       - 100vh resolves TALLER than the visible area, pushing the bottom grid row
         down so the tab-bar labels clip off the screen edge (icons survive).
     position:fixed + inset:0 is bounded by the viewport edges, so it fills the
     screen exactly — no undershoot strip, no overshoot clip. height:auto lets
     inset (top:0/bottom:0) drive the box; without it the base height:100dvh
     would win over the bottom inset and reintroduce the dvh strip. Scoped to
     standalone
     so Safari-browser mode keeps the in-flow dvh layout (#544/#547 toolbar fix).
     NOTE: the iOS standalone viewport behaviour can't be reproduced in a
     headless browser — verify the snapshot + labels on-device. */
  @media all and (display-mode: standalone) {
    .app { position: fixed; inset: 0; height: auto; }
  }
  @media (max-width: 639px) {
    /* The nav is the first child (the desktop left sidebar), so on a row grid
       it auto-places into the top row. Pin main to the flexible top row and the
       nav to the auto bottom row so the in-flow tab bar sits at the bottom of
       the dvh shell — no fixed positioning, so it can't drift above the home
       indicator or below a retracting Safari toolbar. */
    .app { grid-template-columns: 1fr; grid-template-rows: 1fr auto; }
    .app > .main { grid-row: 1; }
    .app > .nav  { grid-row: 2; }
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
    overflow: hidden;
    box-shadow: var(--shadow-soft);
  }
  /* The mark is the self-contained robot SVG (its own navy tile); the tile
     fills the box and the container's radius clips its corners. */
  .nav .brand .logo svg { display: block; width: 100%; height: 100%; }
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
  /* Identity header inside the account menu. Desktop already shows the name +
     email inline in the footer (.who), so it's hidden here; it only appears in
     the mobile popover sheet (see the media query below). */
  .nav .me .acct-id { display: none; }

  @media (max-width: 639px) {
    /* In-flow bottom bar: the second row of the dvh app-shell grid. Because the
       shell is sized with 100dvh (not a fixed inset:0 / layout-viewport box),
       this row hugs the live visual bottom — flush above the home indicator and
       immune to the iOS Safari toolbar gap that an earlier position:fixed
       version still showed on tall-safe-area devices (e.g. iPhone 14 Pro Max).
       The safe-area is reserved via padding-bottom below. */
    .nav {
      border-right: none; border-top: 1px solid var(--hairline);
      background: color-mix(in srgb, var(--bg-2) 92%, transparent);
      -webkit-backdrop-filter: saturate(180%) blur(14px);
      backdrop-filter: saturate(180%) blur(14px);
      flex-direction: row;
      align-items: stretch;
      justify-content: space-around;
      /* Keep the bar compact and native-tight: the bottom inset is the
         home-indicator safe area (env ~34px) plus just 2px breathing — the only
         space that can sit below the labels (tappable content can't go under the
         indicator). Top padding is small so the whole bar reads like an iOS tab
         bar (~49px + safe area) rather than an oversized block. */
      padding: 4px max(8px, env(safe-area-inset-left)) calc(2px + var(--safe-bottom)) max(8px, env(safe-area-inset-right));
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
      gap: 3px; width: 100%; min-height: 46px;
      background: transparent; border: none; cursor: pointer;
      color: var(--ink-dim); font-size: 11px;
      padding: 4px 4px 2px;
    }
    .nav .me .acct-tab .icon {
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
    }
    /* The nav SVGs carry an 18px (account: 20px) width attribute sized for the
       desktop sidebar. On the mobile bottom bar, force them to 22px so they
       match the system-pages bottom-tabs icons (tab-ico, 22px). CSS beats the
       SVG presentation attribute, so the desktop sidebar is unaffected. */
    .nav .items li button .icon svg,
    .nav .me .acct-tab .icon svg {
      width: 22px;
      height: 22px;
    }
    .nav .me.open .acct-tab { color: var(--accent); }
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
    /* Signed-in identity at the top of the popover sheet. The footer's inline
       .who is collapsed on mobile, so this is the only place the account email
       surfaces. A hairline separates it from the action links below. */
    .nav .me .acct-id {
      display: block;
      padding: 6px 12px 10px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--hairline);
    }
    .nav .me .acct-id-name {
      color: var(--ink); font-size: 14px; font-weight: 600; line-height: 1.3;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .nav .me .acct-id-email {
      color: var(--ink-mute); font-size: 12px; line-height: 1.3;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
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
      padding: 4px 4px 2px;
      min-height: 46px;
      font-size: 11px;
      text-align: center;
      border-radius: 8px;
    }
    .nav .items li button.active::before { display: none; }
    .nav .items li button.active { background: transparent; color: var(--accent); }
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
    /* The bottom nav is now an in-flow grid row (not overlapping content), so
       the view only needs its own bottom padding — the bar and the
       home-indicator safe area take their own space below this scroll area. */
    .view { padding: 14px 16px 28px; }
  }

  /* ===== In-SPA pane view ===== */
  /* Full-bleed: the pane shell is framed edge-to-edge, so this view drops the
     standard padding/max-width and fills the .main scroll area. .main has a
     definite height (1fr of the 100dvh app grid), so height:100% cascades down
     to the iframe. The display:flex override beats the generic .view.active
     display:block via attribute-selector specificity. There is no in-SPA chrome
     (no back bar) — the browser Back button drives the exit via popstate. */
  .view[data-view="pane"] { padding: 0; max-width: none; height: 100%; }
  .view[data-view="pane"].active { display: flex; flex-direction: column; }
  .pane-host-frame { flex: 1; width: 100%; border: 0; display: block; background: #fff; min-height: 0; }
  /* While a pane is open the SPA chrome (left sidebar / bottom tab bar) is
     hidden so the pane fills the whole viewport. activate() toggles
     .viewing-pane on .app; collapsing the nav grid track lets .main span full. */
  .app.viewing-pane { grid-template-columns: 1fr; }
  .app.viewing-pane > .nav { display: none; }
  @media (max-width: 639px) {
    .app.viewing-pane { grid-template-rows: 1fr; }
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

  /* ============== Settings view ============== */
  .settings-card {
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: 12px;
    padding: 16px 18px;
    margin-bottom: 16px;
    max-width: 640px;
  }
  .settings-card h2 { margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--ink); }
  .settings-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--hairline);
  }
  .settings-row:last-child { border-bottom: none; padding-bottom: 0; }
  .settings-row .k { font-size: 13px; color: var(--ink); }
  .settings-row .v { font-size: 13px; color: var(--ink-mute); font-family: var(--mono); }
  .settings-note { color: var(--ink-mute); font-size: 13px; margin: 4px 0 14px; }
  .settings-note a { color: var(--accent); }
  .pill { font-size: 11px; padding: 2px 9px; border-radius: 999px; font-weight: 600; white-space: nowrap; }
  .pill.good { background: rgba(52, 211, 153, 0.14); color: #34d399; }
  .pill.muted { background: var(--surface-2); color: var(--ink-mute); }
  /* Secondary status line under a settings-row label (e.g. the notifications toggle state). */
  .settings-row .k-sub { display: block; font-size: 12px; color: var(--ink-mute); margin-top: 2px; }
  /* Toggle switch — a button[role=switch] styled as an iOS-style slider. */
  .switch {
    position: relative; flex: none; width: 40px; height: 24px;
    border-radius: 999px; background: var(--surface-2);
    border: 1px solid var(--hairline); cursor: pointer; padding: 0;
    transition: background .15s, border-color .15s;
  }
  .switch::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 18px; height: 18px; border-radius: 50%; background: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); transition: transform .15s;
  }
  .switch[aria-checked="true"] { background: var(--accent); border-color: var(--accent); }
  .switch[aria-checked="true"]::after { transform: translateX(16px); }
  .switch:disabled { opacity: .5; cursor: not-allowed; }

  /* ============== Top-level controls (search + profile) ============== */
  .search {
    position: relative;
    width: 100%;
    max-width: 460px;
  }
  .search input {
    width: 100%;
    background: var(--surface);
    border: 1px solid rgba(244,201,140,.32);
    border-radius: 10px;
    padding: 9px 12px 9px 34px;
    color: var(--ink);
    font-size: 14px;
    font-family: inherit;
  }
  .search input:focus { outline: none; border-color: var(--accent); }
  .search .icon {
    position: absolute; left: 10px; top: 50%;
    transform: translateY(-50%);
    color: var(--ink-mute);
    pointer-events: none;
  }
  .search input::placeholder { color: var(--ink-mute); }
  /* Segmented control — Yours / Store scope switch on the Templates view. */
  .seg {
    display: inline-flex; gap: 2px; margin: 0 0 16px;
    padding: 3px; border-radius: 10px;
    background: var(--surface-2); border: 1px solid var(--hairline);
  }
  .seg-btn {
    appearance: none; border: none; background: transparent; cursor: pointer;
    display: inline-flex; align-items: center; gap: 7px;
    padding: 6px 14px; border-radius: 7px;
    color: var(--ink-mute); font-family: inherit; font-size: 13px; font-weight: 600;
    transition: color 100ms, background 100ms;
  }
  .seg-btn:hover { color: var(--ink); }
  .seg-btn[aria-selected="true"] {
    background: var(--surface); color: var(--ink);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
  }
  .seg-btn .count {
    font-size: 11px; font-weight: 600; color: var(--ink-mute);
    background: var(--surface-3); border-radius: 999px; padding: 1px 7px;
  }
  .seg-btn[aria-selected="true"] .count { color: var(--accent); }
  .seg-panel[hidden] { display: none; }

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

  /* First-run "connect your first agent" nudge — shown on /home only while
     the human has zero claimed agents. Links to /get-started. */
  .gs-nudge {
    display: flex; align-items: center; gap: 14px;
    margin: 4px 0 22px; padding: 14px 16px;
    border: 1px solid var(--accent); border-radius: 14px;
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
    color: var(--ink); transition: background .15s ease, transform .12s ease;
  }
  .gs-nudge:hover { background: color-mix(in srgb, var(--accent) 13%, var(--surface)); transform: translateY(-1px); }
  .gs-nudge-icon { flex: none; width: 38px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: var(--accent); color: #fff; }
  .gs-nudge-icon svg { width: 20px; height: 20px; }
  .gs-nudge-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .gs-nudge-text b { font-size: 14.5px; font-weight: 650; }
  .gs-nudge-text span { color: var(--ink-dim); font-size: 13px; }
  .gs-nudge-cta { margin-left: auto; flex: none; color: var(--accent); font-weight: 650; font-size: 13.5px; }
  @media (max-width: 560px) {
    .gs-nudge-cta { display: none; }
  }

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
    color: var(--accent);
    cursor: pointer;
  }
  .section-head a:hover { text-decoration: underline; }

  /* Favorites strip (horizontal scroll) */
  /* Two fixed rows that scroll horizontally together — a 2-row carousel.
     grid-auto-flow:column fills top-to-bottom then advances a column, so the
     pair of rows shares one horizontal scrollbar. Tiles keep their original
     size (grid-auto-columns), not stretched. */
  .favs {
    display: grid;
    grid-auto-flow: column;
    grid-template-rows: repeat(2, auto);
    grid-auto-columns: 96px;
    gap: 12px;
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

  /* Recent panes — a responsive wrap grid that scrolls with the page instead
     of sideways. auto-fill + minmax(160px, 1fr) yields ~2 columns on a phone
     and more as the viewport widens, with columns stretching to fill the row
     so nothing overflows horizontally or hides behind a sideways scrollbar. */
  .recents {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 14px;
    padding: 4px 2px 2px;
    margin: 0 -2px;
  }
  /* Each recent is a visual card — a full-bleed live thumbnail of the pane
     itself with the title + last-viewed overlaid on a gradient scrim, the same
     shape as the Explore gallery card. Unlike Explore's fixed-width cards, the
     recents grid is fluid (minmax 1fr), so the preview can't use a fixed scale
     factor. scale() needs a unitless number (a length like 100cqw/1000 is
     invalid and silently dropped, which leaves the 1000px preview unscaled —
     a zoomed-in crop), so the card width is measured in JS and fed in as the
     --rc-scale number; see the ResizeObserver in owner-shell-spa.ts. */
  .recent-card {
    position: relative;
    display: block;
    aspect-ratio: 16 / 11;
    border-radius: var(--radius-card);
    overflow: hidden;
    border: 1px solid rgba(244,201,140,.28);
    box-shadow: var(--shadow-soft);
    background: var(--surface);
    text-decoration: none;
    color: inherit;
    cursor: pointer;
    transition: transform .15s, box-shadow .15s;
  }
  .recent-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-pop); }
  .recent-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .recent-card .rc-prev { position: absolute; inset: 0; overflow: hidden; }
  .recent-card .rc-mono {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: #07090f; font-weight: 800; font-size: 34px;
  }
  /* Visibility badge + ⋯ menu as corner chips over the preview (top-right).
     Both stay visible (no hover-reveal) so they work on touch; z-index sits
     above the .tile-preview iframe and the scrim, and pointer-events: auto
     guarantees clicks land on the controls rather than the card behind. */
  .recent-card .rc-corner {
    position: absolute; top: 8px; right: 8px; z-index: 3;
    display: flex; gap: 6px;
  }
  .recent-card .recent-vis,
  .recent-card .recent-menu-btn {
    width: 24px; height: 24px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 7px;
    background: rgba(0,0,0,0.5); color: #fff;
    pointer-events: auto;
  }
  .recent-card .recent-menu-btn { border: none; cursor: pointer; transition: background 120ms; }
  .recent-card .recent-menu-btn:hover { background: rgba(0,0,0,0.72); }
  .recent-card .recent-vis svg,
  .recent-card .recent-menu-btn svg { display: block; }
  /* Warm amber-tinted scrim — crushed brand-2 (#f4c98c) gives a deep cognac
     undertone instead of pure black. Reads as "pane-brand warm" without
     overpowering the live preview underneath. */
  .recent-card .rc-scrim {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
    padding: 26px 12px 10px;
    background: linear-gradient(to top, rgba(62,38,12,.92) 0%, rgba(62,38,12,.55) 45%, transparent 100%);
    color: #fff;
  }
  .recent-card .rc-title {
    font-weight: 700; font-size: 14px; letter-spacing: -0.01em;
    color: #fff2db;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .recent-card .rc-meta {
    font-size: 12px; color: rgba(255,236,210,.80);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
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
  /* Adaptive hover tint: derived from --ink so it lifts on dark (light ink)
     and on light (dark ink) instead of an invisible white-on-white wash. */
  .app-tile:hover { background: color-mix(in srgb, var(--ink) 5%, transparent); }
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
    border: 1px solid rgba(244,201,140,.28);
    border-radius: 12px;
    padding: 12px 14px;
    display: grid;
    /* icon | info | actions — three cells. The three trailing controls
       (visibility, star, ⋯ menu) live together in one .row-actions flex cell so
       they cluster tightly instead of each sitting a full 14px grid gap apart —
       on mobile every px of that whitespace is title width. (Share was dropped
       from the row — it lives in the pane shell's top bar now.) */
    grid-template-columns: 44px 1fr auto;
    gap: 14px;
    align-items: center;
    cursor: pointer;
    transition: border-color 150ms;
  }
  .pane-row:hover { border-color: rgba(244,201,140,.55); }
  /* The row carries a data-fav attribute (mirrored on toggle from the star) so
     the "★ Favorites" chip filter can scope. No visual treatment on the row
     itself — the star icon alone marks the state. */
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
  /* Open panes render an empty status cell (no pill) — collapse it so the
     title reclaims the width. Closed panes keep their pill. */
  .pane-row .status:empty { padding: 0; }
  .pane-row .status.open    { background: rgba(110, 231, 183, 0.1); color: var(--green); }
  .pane-row .status.closed  { background: var(--surface-2); color: var(--ink-mute); }
  .pane-row .status.expiring { background: rgba(252, 211, 77, 0.1); color: var(--amber); }
  /* Explore (public-pane) rows surface a positive "live" pill — unlike the
     Panes list, where an open pane is the unremarkable default and gets no
     pill. A small leading dot reinforces the live state. */
  .pane-row .status.live { background: rgba(110, 231, 183, 0.1); color: var(--green); }
  .pane-row .status.live::before {
    content: ''; display: inline-block; width: 6px; height: 6px;
    border-radius: 999px; background: currentColor; margin-right: 5px;
    vertical-align: middle;
  }
  /* The trailing controls cluster — visibility icon, star, ⋯ menu — packed
     tight (2px) rather than spread across grid gaps, so the title keeps the
     width. Buttons still carry their own 40px hit targets internally. */
  .pane-row .row-actions {
    display: flex; align-items: center; gap: 2px;
  }
  /* Visibility icon cell on a pane row (lock / link / globe). Muted so it
     reads as metadata, not an action; the title attr names the access mode. */
  .pane-row .vis {
    color: var(--ink-mute);
    display: inline-flex; align-items: center; justify-content: center;
  }
  .pane-row .vis svg { display: block; }
  .pane-row .menu-btn {
    width: 40px; height: 40px;
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
  .sheet input:focus, .sheet select:focus, .sheet textarea:focus { outline: none; border-color: var(--accent); }

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
    color: var(--accent);
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
  .toast .ic { color: var(--accent); font-weight: 700; }
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
  .chrome-bad .row1 .tabs a.active { color: #D97757; font-weight: 600; }
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
    background: linear-gradient(135deg, #D97757, #E0A23A);
    color: #ffffff; font-weight: 700; font-size: 12px;
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
    border: 1px solid var(--accent);
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
    background: color-mix(in srgb, var(--ink) 8%, transparent);
    padding: 1px 5px; border-radius: 3px; color: var(--accent);
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

  /* ----- Live artifact preview thumbnails -----
   * A lazy, sandboxed <iframe> rendering the real artifact, layered over the
   * gradient monogram on BIG cards (favorites 76px, app tiles 64px, recents
   * 280x100 thumb). Only emitted when the icon would otherwise be the monogram
   * fallback — image / emoji icons never carry one, and the 44px pane-row keeps
   * the bare monogram.
   *
   * The trick: render the iframe at a large LOGICAL viewport (1000px wide) so
   * the artifact lays out like a real page, then transform:scale() it down
   * to the tile so it reads as a shrunk web page rather than a cropped corner.
   * transform-origin:top left anchors the scale to the tile's corner; the
   * tile container clips the overflow. pointer-events:none keeps the card
   * itself clickable (the iframe would otherwise swallow the click). */
  .tile-preview {
    position: absolute;
    top: 0; left: 0;
    width: ${PVF}px;
    border: 0;
    background: transparent;
    transform-origin: top left;
    pointer-events: none;
    /* Above the monogram, below any badge/tag the card lays over it. */
    z-index: 1;
  }
  /* Favorites — 76px SQUARE icon. The frame is a square ${PVF}px box; the
   * preview doc renders the pane's 1000px desktop layout into it via zoom, and
   * scaling by 76/${PVF} covers the tile exactly with no monogram gap. */
  .fav-tile .icon { overflow: hidden; }
  .fav-tile .icon .tile-preview {
    height: ${PVF}px;
    transform: scale(${76 / PVF});
  }
  /* App tiles — 64px SQUARE icon. Square ${PVF}px frame so the scaled iframe
   * covers the whole 64x64 tile with no gradient strip beneath.
   * .icon needs the clip + a stacking context (it isn't positioned by default). */
  .app-tile .icon { overflow: hidden; position: relative; }
  .app-tile .icon .tile-preview {
    height: ${PVF}px;
    transform: scale(${64 / PVF});
  }
  /* Recents — fluid-width gallery card (aspect 16/11). The frame renders the
   * pane's 1000px DESKTOP layout (zoom in the preview doc) into a ${PVF}px-wide
   * box; --rc-scale (= card width / ${PVF}, set per card by the ResizeObserver in
   * owner-shell-spa.ts) scales it to the column width instead of a zoomed crop.
   * The card is 11/16 as tall as wide, so the frame height is ${PVF}*11/16 — the
   * scaled iframe covers the card edge to edge. Default holds before the
   * observer fires. */
  .recent-card .tile-preview {
    height: ${PVF_169}px;
    transform: scale(var(--rc-scale, 0.67));
  }

  /* ============== Explore gallery cards ==============
   * The Explore tab is a visual gallery (not the dense .pane-row list): each
   * card is a full-bleed live thumbnail of the pane itself, with the title +
   * sharer overlaid on a gradient scrim and a live/ended pill in the corner.
   * The grid is FLUID — cards stretch to fill the row (one column on a phone,
   * more as the viewport widens) instead of fixed-width cards that leave dead
   * space. Because the card width varies, the .tile-preview scale factor can't
   * be a CSS constant; JS sets it per card from the real width (see
   * scaleExplorePreviews in owner-shell-spa). The 16:11 aspect keeps the
   * preview's logical HEIGHT constant (1000 * 11/16 ≈ 688px), so only the
   * scale changes. */
  .explore-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr));
    gap: 18px;
  }
  .explore-grid .empty-strip { grid-column: 1 / -1; }
  .explore-card {
    position: relative;
    display: block;
    aspect-ratio: 16 / 11;
    border-radius: var(--radius-card);
    overflow: hidden;
    border: 1px solid rgba(244,201,140,.28);
    box-shadow: var(--shadow-soft);
    background: var(--surface);
    text-decoration: none;
    color: inherit;
    cursor: pointer;
    transition: transform .15s, box-shadow .15s;
  }
  .explore-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-pop); }
  .explore-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .ec-prev { position: absolute; inset: 0; overflow: hidden; }
  /* ${PVF}px frame rendering the pane's 1000px desktop layout (zoom in the
   * preview doc, like favorites/recents), scaled to the card's real width by JS.
   * Default scale (~260px min column / ${PVF}) keeps first paint sensible before
   * JS runs; height = ${PVF}*11/16 so the scaled iframe covers the 16:11 card. */
  .explore-card .tile-preview { height: ${PVF_169}px; transform: scale(${260 / PVF}); }
  .ec-corner { position: absolute; top: 8px; right: 8px; z-index: 2; }
  .ec-scrim {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
    padding: 26px 12px 10px;
    background: linear-gradient(to top, rgba(62,38,12,.92) 0%, rgba(62,38,12,.55) 45%, transparent 100%);
    color: #fff;
  }
  .ec-title {
    font-weight: 700; font-size: 14px; letter-spacing: -0.01em;
    color: #fff2db;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ec-meta {
    font-size: 12px; color: rgba(255,236,210,.80);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ec-pill {
    display: inline-flex; align-items: center; gap: 5px;
    font: 600 11px/1 var(--sans);
    padding: 4px 9px; border-radius: var(--radius-pill);
  }
  .ec-pill.live { color: #d5ffe8; background: rgba(34,176,107,0.42); }
  .ec-pill.ended { color: rgba(255,255,255,0.85); background: rgba(0,0,0,0.45); }
  .ec-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #22b06b;
    box-shadow: 0 0 0 0 rgba(34,176,107,0.6);
    animation: ec-pulse 2s infinite;
  }
  @keyframes ec-pulse {
    0% { box-shadow: 0 0 0 0 rgba(34,176,107,0.5); }
    70% { box-shadow: 0 0 0 6px rgba(34,176,107,0); }
    100% { box-shadow: 0 0 0 0 rgba(34,176,107,0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .explore-card { transition: none; }
    .ec-dot { animation: none; }
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
  .ai-modal-lead code { font-family: var(--mono); font-size: 12px; background: color-mix(in srgb, var(--ink) 8%, transparent); padding: 1px 5px; border-radius: 3px; color: var(--accent); }
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
  .ai-modal-copy.copied { color: var(--accent); border-color: var(--accent); }
  .ai-modal-foot { margin: 12px 0 0; color: var(--ink-mute); font-size: 12.5px; }
`;
