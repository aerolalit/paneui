// The shell IIFE: runs in the participant's browser. Holds the WebSocket
// connection and proxies the postMessage protocol between the sandboxed
// iframe (which runs the agent's template + the runtime) and the WS.
//
// Two mount points serve this bundle:
//   - /s/<token>      capability-token mode: the URL embeds a participant
//                     token. The shell's wsTicketAuthorization carries the
//                     `Bearer <token>` it needs to mint a WS ticket; all
//                     other callback URLs are /s/<token>/* paths.
//   - /surfaces/<id>  session mode: the caller is signed in as the surface
//                     owner. The pane_login cookie authenticates each
//                     request (including the ws-ticket mint, which carries
//                     no Authorization header); callback URLs are
//                     /surfaces/<id>/* paths.
// The shell does not need to know which mode it is in — both paths are
// expressed through the injected URLs in ShellCfg below.
//
// Config is delivered via a sibling `<script type="application/json" id="pane-cfg">`
// block emitted by routes.ts, NOT via template interpolation into this JS source.
// That keeps the only attack surface in routes.ts (which already neutralises
// `</script>` in the JSON via JSON.stringify behaviour for `<` inside strings).
//
// `export {}` makes this a module (needed for TS file scoping). The relay's
// loadClient() strips it before inlining — `export` is a SyntaxError in the
// classic <script> the file is injected into.
export {};

// The shell <-> iframe frame envelope is defined ONCE in ./protocol.ts and
// shared (as a type) with the runtime bundle, so the two sides cannot drift.
// `import type` is fully erased by the compiler — nothing reaches this IIFE.
import type { PaneFrameEnvelope, ShellToRuntimeKind } from "./protocol.js";

// #296 — inlined RecordStore.
//
// Why inlined: shell.client.ts is compiled by tsc (not bundled) and the
// resulting JS is then loaded by the relay's loadClient() helper and evaluated
// as a CLASSIC script inside the browser AND under jsdom in the unit tests.
// A cross-module `import { RecordStore } from "./record-store.js"` would
// survive into the compiled output as a top-level `import` statement, which
// is a SyntaxError in classic-script eval. So we keep two copies of the
// class:
//
//   * The CANONICAL one lives in ./record-store.ts and is unit-tested
//     directly (record-store.test.ts, 11 tests).
//   * The INLINE one below is loaded into the shell IIFE. Must stay in
//     sync with the canonical source.
//
// A future bundler pass over shell.client.ts could eliminate this
// duplication, but that's its own structural change.

interface ShellSerializedRecord {
  id: string;
  collection: string;
  key: string;
  data: unknown;
  version: number;
  seq: number;
  author: { kind: "agent" | "human" | "system"; id: string };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
interface ShellDeletedRecordRef {
  id: string;
  key: string;
  seq: number;
  deleted_at: string;
}
interface ShellRecordUpsertMessage {
  kind: "record.upsert";
  collection: string;
  record: ShellSerializedRecord;
}
interface ShellRecordDeleteMessage {
  kind: "record.delete";
  collection: string;
  record: ShellDeletedRecordRef;
}
type ShellRecordDelta =
  | { kind: "upsert"; collection: string; record: ShellSerializedRecord }
  | { kind: "delete"; collection: string; record: ShellDeletedRecordRef };

class RecordStore {
  private readonly byCollection = new Map<
    string,
    Map<string, ShellSerializedRecord>
  >();
  private readonly lastSeq = new Map<string, number>();

  applyUpsert(msg: ShellRecordUpsertMessage): ShellRecordDelta | null {
    const last = this.lastSeq.get(msg.collection) ?? 0;
    if (msg.record.seq <= last) return null;
    let inner = this.byCollection.get(msg.collection);
    if (!inner) {
      inner = new Map();
      this.byCollection.set(msg.collection, inner);
    }
    inner.set(msg.record.key, msg.record);
    this.lastSeq.set(msg.collection, msg.record.seq);
    return { kind: "upsert", collection: msg.collection, record: msg.record };
  }

  applyDelete(msg: ShellRecordDeleteMessage): ShellRecordDelta | null {
    const last = this.lastSeq.get(msg.collection) ?? 0;
    if (msg.record.seq <= last) return null;
    const inner = this.byCollection.get(msg.collection);
    if (inner) inner.delete(msg.record.key);
    this.lastSeq.set(msg.collection, msg.record.seq);
    return { kind: "delete", collection: msg.collection, record: msg.record };
  }

  snapshot(collection: string): ShellSerializedRecord[] {
    const inner = this.byCollection.get(collection);
    if (!inner) return [];
    return Array.from(inner.values());
  }

  observedCollections(): string[] {
    return Array.from(this.lastSeq.keys());
  }

  reconnectCursorQuery(): string {
    if (this.lastSeq.size === 0) return "";
    const parts: string[] = [];
    for (const [name, seq] of this.lastSeq.entries()) {
      parts.push(`since_record_seq.${encodeURIComponent(name)}=${seq}`);
    }
    return parts.join("&");
  }
}

/** An outbound frame the shell posts to the iframe. */
type OutboundFrame = PaneFrameEnvelope & {
  kind: ShellToRuntimeKind;
  [k: string]: unknown;
};

interface ShellCfg {
  surfaceId: string;
  schema: unknown;
  // The surface's per-instance input_data — the relay validated it against the
  // template version's input_schema at create time. Forwarded to the iframe in
  // the `init` frame; the runtime exposes it as `window.pane.inputData`.
  inputData: unknown;
  // Same-origin endpoints the shell calls back into. Injected (rather than
  // constructed from a token) so the same shell bundle drives BOTH auth modes:
  //   - capability-token mode (/s/<token>) — URLs include the token in the path
  //   - session mode (/surfaces/<id>) — URLs are id-keyed; the pane_login
  //     cookie authenticates each call.
  presenceUrl: string;
  wsTicketUrl: string;
  // Authorization header value for the ws-ticket call. Null in session mode
  // (the cookie travels automatically); the participant bearer in token mode.
  wsTicketAuthorization: string | null;
  attachmentsUploadUrl: string;
  // Append `/<attachmentId>` to form a download URL. Carrying the prefix
  // (rather than a template string) keeps the encoding boundary obvious.
  attachmentsDownloadUrlBase: string;
  wsUrl: string;
  isClosed: boolean;
  // Live agent-presence facts, computed by the relay at request time. These
  // SEED the agent-presence pill; the shell then keeps it live from events
  // received after `system.replay.complete` (see the presence section below).
  //  - agentLive: an agent WebSocket was open on this surface at request time.
  //  - agentLastEventAt: ISO ts of the most recent agent-authored event.
  //  - agentLastUsedAt: ISO ts of the owning agent's last authenticated request.
  agentLive: boolean;
  agentLastEventAt: string | null;
  agentLastUsedAt: string | null;
}

interface SerializedEvent {
  id: string;
  type: string;
  data: unknown;
  [k: string]: unknown;
}

(function () {
  const cfgEl = document.getElementById("pane-cfg");
  if (!cfgEl || !cfgEl.textContent) return;
  const CFG: ShellCfg = JSON.parse(cfgEl.textContent);

  const dot = document.getElementById("dot")!;
  const statusEl = document.getElementById("status")!;
  const agentDot = document.getElementById("agent-dot")!;
  const agentStatusEl = document.getElementById("agent-status")!;
  const frame = document.getElementById("frame") as HTMLIFrameElement | null;
  let iframeReady = false;
  let replayDone = false;
  const replayBuffer: SerializedEvent[] = [];
  let lastEventId = 0;
  // #296 — per-shell record store. Keyed by (collection, recordKey); seq
  // tracking drives the reconnect cursors. The iframe-postMessage routing
  // that exposes this to `pane.records.*` is #298's scope.
  const recordStore = new RecordStore();
  let ws: WebSocket | null = null;
  let backoff = 1000;
  // Guards against overlapping connections. `connect()` can be reached from two
  // places — the initial call and the close-handler's reconnect timer — and a
  // browser WebSocket killed by an idle-reaping proxy reconnects on a tight
  // cadence. Without these guards a slow `open` plus a queued reconnect could
  // leave two live sockets, each with its own close handler each scheduling
  // its own reconnect: the connection count doubles every cycle and the relay
  // sees a storm of participant.joined/left pairs. `connecting` blocks a second
  // connect() while one is already in flight; `reconnectTimer` ensures only one
  // reconnect is ever queued.
  let connecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(t: string, cls?: "up" | "dn"): void {
    statusEl.textContent = t;
    dot.className = "dot" + (cls ? " " + cls : "");
  }

  // --- Agent presence -------------------------------------------------------
  // Presence is LIVE runtime state. It is NOT reconstructed by replaying the
  // persisted `system.participant.joined`/`left` log — a `left` event is
  // written fire-and-forget by the relay and can be lost, which would leave a
  // stale `joined` claiming an agent is connected forever. So:
  //
  //  - Before `system.replay.complete`: trust ONLY the seed facts from CFG
  //    (agentLive / agentLastEventAt / agentLastUsedAt), which the relay
  //    computed from present-tense signals at request time.
  //  - After `system.replay.complete`: trust the live agent socket count that
  //    the relay stamps onto every participant.joined/left event as
  //    `data.agentCountLive`. Replayed (historical) events also carry that
  //    field, but its value reflected the past — so we IGNORE agentCountLive
  //    until replay completes, then read it from every live participant event.
  //
  // Two pieces of state drive the pill:
  //  1) agentLiveCount — number of agent sockets open right now. Seeded from
  //     CFG.agentLive, then kept exact from post-replay `agentCountLive`.
  //  2) lastAgentActiveMs — the most recent moment an agent touched the
  //     surface (sent an event or pulled events). Seeded from the max of
  //     CFG.agentLastEventAt / agentLastUsedAt, bumped to now() on any live
  //     agent-authored event.
  const RECENT_WINDOW_MS = 5 * 60 * 1000;
  // Green-from-recent-activity window. An agent that MONITORS a surface by
  // polling `pane surface show` (HTTP GET .../events?since=... every few seconds)
  // never opens a WebSocket, yet is just as present as one holding a stream.
  // Every authenticated agent request stamps `Agent.lastUsedAt` server-side,
  // so an agent polling on a few-second cadence keeps `lastUsedAt` well within
  // this window. The shell learns the fresh value by polling /presence.
  const ACTIVE_WINDOW_MS = 30 * 1000;
  // Grace window: an agent monitor often reconnects in short `pane surface watch`
  // cycles (connect -> get event -> exit -> harness re-runs). The live socket
  // count flickers 1 -> 0 -> 1 between cycles. Without a grace period the pill
  // would flap green -> amber -> green. So once a live agent socket has been
  // seen, keep showing "agent active" (green) for this long after it drops —
  // brief reconnection gaps stay green; only a sustained absence falls to amber.
  const LIVE_GRACE_MS = 45 * 1000;
  let agentLiveCount = CFG.agentLive ? 1 : 0;
  // Timestamp of the most recent moment an agent socket was open. Set whenever
  // agentLiveCount is > 0; the grace window is measured from it.
  let lastAgentLiveMs: number | null = CFG.agentLive ? Date.now() : null;
  let lastAgentActiveMs: number | null = null;
  let sawAnyAgentActivity = false;
  for (const iso of [CFG.agentLastEventAt, CFG.agentLastUsedAt]) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (isFinite(t)) {
      if (lastAgentActiveMs === null || t > lastAgentActiveMs)
        lastAgentActiveMs = t;
      sawAnyAgentActivity = true;
    }
  }
  if (CFG.agentLive) sawAnyAgentActivity = true;

  // Relative time, scoped to the 5-minute RECENT_WINDOW — no buckets beyond
  // what that window can ever display.
  function relTime(ms: number): string {
    const d = Math.max(0, Date.now() - ms);
    if (d < 60000) return "just now";
    return Math.floor(d / 60000) + "m ago";
  }

  function renderAgentPresence(): void {
    if (CFG.isClosed) {
      agentStatusEl.textContent = "surface closed";
      agentDot.className = "dot";
      return;
    }
    // GREEN — an agent is actively present right now, via EITHER mechanism:
    //  1) a live WebSocket is open, or within the grace window after one
    //     closed (short reconnection gaps in a monitor loop don't flap), OR
    //  2) the owning agent made an authenticated request — or an
    //     agent-authored event arrived — within ACTIVE_WINDOW_MS (30s). This
    //     covers a monitor that polls `pane surface show` and never opens a socket;
    //     the shell keeps lastAgentActiveMs fresh by polling /presence.
    if (
      agentLiveCount > 0 ||
      (lastAgentLiveMs !== null &&
        Date.now() - lastAgentLiveMs <= LIVE_GRACE_MS)
    ) {
      agentStatusEl.textContent = "agent active";
      agentDot.className = "dot up";
      return;
    }
    if (
      lastAgentActiveMs !== null &&
      Date.now() - lastAgentActiveMs <= ACTIVE_WINDOW_MS
    ) {
      agentStatusEl.textContent = "agent active";
      agentDot.className = "dot up";
      return;
    }
    if (
      lastAgentActiveMs !== null &&
      Date.now() - lastAgentActiveMs <= RECENT_WINDOW_MS
    ) {
      agentStatusEl.textContent = "agent active " + relTime(lastAgentActiveMs);
      agentDot.className = "dot amber";
      return;
    }
    agentStatusEl.textContent = sawAnyAgentActivity
      ? "agent away"
      : "no agent yet";
    agentDot.className = "dot";
  }

  // Fold a single LIVE (post-replay-complete) event into presence state.
  // Replayed events are NOT passed here — historical participant events carry a
  // stale `agentCountLive` and a stale `joined` with no matching `left` would
  // corrupt the count.
  function trackLiveAgentPresence(ev: SerializedEvent): void {
    if (
      ev.type === "system.participant.joined" ||
      ev.type === "system.participant.left"
    ) {
      // The relay stamps the exact current agent socket count onto every
      // participant event it broadcasts — trust it verbatim.
      const n = (ev.data as { agentCountLive?: unknown } | null)
        ?.agentCountLive;
      if (typeof n === "number" && isFinite(n) && n >= 0) {
        agentLiveCount = n;
        if (n > 0) {
          sawAnyAgentActivity = true;
          // Stamp the moment a socket is confirmed open — the grace window
          // (see renderAgentPresence) is measured from this.
          lastAgentLiveMs = Date.now();
        }
      }
      return;
    }
    // Any non-system event authored by an agent proves recent activity.
    const evAuthor = (ev as { author?: { kind?: unknown } }).author;
    if (evAuthor && evAuthor.kind === "agent") {
      lastAgentActiveMs = Date.now();
      sawAnyAgentActivity = true;
    }
  }

  // Poll the relay's /presence endpoint to keep the pill fresh for a polling
  // agent. Such an agent monitors via `pane surface show` HTTP polls and never opens
  // a WebSocket, so the live-socket count and post-replay events never see it
  // — but every authenticated request stamps `Agent.lastUsedAt` server-side.
  // The page-load config seed captures `lastUsedAt` once and then goes stale;
  // without this poll the pill would wrongly fall to amber ~30s later even
  // though the agent is still actively polling.
  //
  // 10s cadence: comfortably inside the 30s ACTIVE_WINDOW_MS, so a green pill
  // is refreshed ~3x before it could expire — yet light enough for a polled,
  // unauthenticated-beyond-the-token JSON endpoint.
  const PRESENCE_POLL_MS = 10000;

  // Same-origin: the shell is served by the relay, so /presence sits under the
  // relay origin. connect-src 'self' in the shell-page CSP already covers it.
  const presenceUrl = window.location.origin + CFG.presenceUrl;

  async function pollPresence(): Promise<void> {
    if (CFG.isClosed) return;
    let body: {
      agentLive?: unknown;
      agentLastEventAt?: unknown;
      agentLastUsedAt?: unknown;
    };
    try {
      const res = await fetch(presenceUrl, { cache: "no-store" });
      if (!res.ok) return; // skip this tick — never break the pill
      body = await res.json();
    } catch {
      return; // network blip — skip quietly, try again next tick
    }
    // A live agent socket seen by the relay counts as a fresh sighting, the
    // same as a post-replay participant.joined would.
    if (body.agentLive === true) {
      lastAgentLiveMs = Date.now();
      sawAnyAgentActivity = true;
    }
    for (const iso of [body.agentLastEventAt, body.agentLastUsedAt]) {
      if (typeof iso !== "string") continue;
      const t = Date.parse(iso);
      if (!isFinite(t)) continue;
      if (lastAgentActiveMs === null || t > lastAgentActiveMs)
        lastAgentActiveMs = t;
      sawAnyAgentActivity = true;
    }
    renderAgentPresence();
  }

  renderAgentPresence();
  // "active 2m ago" must advance on its own even when no events arrive.
  setInterval(renderAgentPresence, 20000);
  // Keep the seed facts live (see pollPresence). This interval also re-renders
  // the pill via pollPresence's renderAgentPresence() call.
  setInterval(() => void pollPresence(), PRESENCE_POLL_MS);
  void pollPresence();

  // The iframe is sandboxed WITHOUT allow-same-origin, so it runs at the opaque
  // "null" origin. postMessage does NOT accept the literal string "null" as a
  // targetOrigin (it throws "Invalid target origin"), and an opaque origin has
  // no concrete value to pin to — so the only valid choice is "*".
  // This is not a broadcast: every post below targets `frame.contentWindow`
  // directly, so the message only ever reaches that one sandboxed iframe.
  // "*" only relaxes the recipient-origin check, which an opaque iframe would
  // fail anyway. The trust boundary is the sandbox + the contentWindow ref.
  const IFRAME_ORIGIN = "*";

  // Cap correlation_id everywhere it crosses the shell. The runtime generates
  // short strings ("c1", "c2", ...). The cap exists to stop a buggy or
  // hostile template from forcing the relay to materialise a huge string
  // into every ack/error response.
  function validCid(v: unknown): v is string {
    return typeof v === "string" && v.length > 0 && v.length <= 128;
  }

  function sendIframeInit(): void {
    if (!iframeReady || !replayDone || !frame || !frame.contentWindow) return;
    const frameMsg: OutboundFrame = {
      __pane: 1,
      v: 1,
      kind: "init",
      payload: {
        surface_id: CFG.surfaceId,
        schema: CFG.schema,
        replay: replayBuffer.slice(),
        shell_origin: window.location.origin,
        input_data: CFG.inputData,
      },
    };
    frame.contentWindow.postMessage(frameMsg, IFRAME_ORIGIN);
  }

  function pushToIframe(ev: SerializedEvent): void {
    if (!iframeReady || !frame || !frame.contentWindow) return;
    const frameMsg: OutboundFrame = {
      __pane: 1,
      v: 1,
      kind: "event",
      payload: ev,
    };
    frame.contentWindow.postMessage(frameMsg, IFRAME_ORIGIN);
  }

  // #298 — push a record delta (the shell's store already did the merge +
  // stale-seq check; we just forward to the iframe so the runtime can fire
  // pane.records.on handlers).
  function pushRecordDeltaToIframe(
    op: "upsert" | "delete",
    collection: string,
    record: unknown,
  ): void {
    if (!iframeReady || !frame || !frame.contentWindow) return;
    const frameMsg = {
      __pane: 1 as const,
      v: 1 as const,
      kind: "record-delta" as const,
      op,
      collection,
      record,
      // The op-discriminator type lives in protocol.ts but cast here is fine —
      // both sides agree on the wire shape, postMessage is structural-clone.
    } as unknown as OutboundFrame;
    frame.contentWindow.postMessage(frameMsg, IFRAME_ORIGIN);
  }

  // #298 — push the initial record-snapshot to the iframe (one frame, all
  // collections). Sent right after `init` so the template's first
  // pane.records.snapshot() call sees the replayed state without waiting.
  function pushRecordSnapshotToIframe(): void {
    if (!iframeReady || !frame || !frame.contentWindow) return;
    // Build { collection -> RecordRow[] } from the store. The store doesn't
    // expose its collection list; iterate over what's been observed.
    const collections: Record<string, unknown[]> = {};
    for (const name of recordStore.observedCollections()) {
      collections[name] = recordStore.snapshot(name);
    }
    const frameMsg = {
      __pane: 1 as const,
      v: 1 as const,
      kind: "record-snapshot" as const,
      collections,
    } as unknown as OutboundFrame;
    frame.contentWindow.postMessage(frameMsg, IFRAME_ORIGIN);
  }

  // Schedule exactly one reconnect attempt. Coalesces: if a timer is already
  // pending (e.g. a stray second close fired) we do not stack another.
  function scheduleReconnect(): void {
    if (CFG.isClosed || reconnectTimer !== null) return;
    setStatus("reconnecting in " + Math.round(backoff / 1000) + "s...", "dn");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(backoff * 2, 30000);
      connect();
    }, backoff);
  }

  // Tear down the current socket so it can never fire another close/message
  // into the app after we've moved on. We strip its listeners first so the old
  // socket's close event can't trigger a second reconnect.
  function teardownWs(): void {
    if (!ws) return;
    const old = ws;
    ws = null;
    old.onopen = null;
    old.onmessage = null;
    old.onclose = null;
    old.onerror = null;
    try {
      old.close();
    } catch {
      /* already closing */
    }
  }

  // Mint a fresh single-use WebSocket ticket. Browsers can't set an
  // Authorization header on `new WebSocket()`, so the WS URL must carry a
  // credential as a query parameter — and a long-lived token there leaks
  // into upstream proxy access logs. The browser path therefore mints a
  // short-lived single-use ticket over HTTP first (cookie auth in session
  // mode; Bearer participant token in capability-token mode) and puts the
  // TICKET in the WS URL instead — a 30s TTL value worth nothing if it
  // leaks.
  // ticket (30s TTL, single-use) and puts the TICKET in the WS URL instead.
  // A fresh ticket is minted before EVERY connect (incl. reconnects) because a
  // ticket is single-use and expires after 30s. See relay issue #8.
  const ticketUrl = window.location.origin + CFG.wsTicketUrl;

  async function mintTicket(): Promise<string> {
    const headers: Record<string, string> = {};
    if (CFG.wsTicketAuthorization) {
      headers["authorization"] = CFG.wsTicketAuthorization;
    }
    const res = await fetch(ticketUrl, {
      method: "POST",
      headers,
      // Session mode authenticates via the pane_login cookie. The cookie is
      // first-party + same-origin so this is a no-op for the token path; spell
      // it out anyway so a future strict-cookie default never silently breaks
      // the owner-shell call.
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error("ws-ticket mint failed: " + res.status);
    }
    const body = (await res.json()) as { ticket?: unknown };
    if (typeof body.ticket !== "string" || body.ticket.length === 0) {
      throw new Error("ws-ticket mint returned no ticket");
    }
    return body.ticket;
  }

  function connect(): void {
    if (CFG.isClosed) return;
    // Never run two connections at once. If one is already opening or open,
    // bail — whatever triggered this call (a stale close, a double-invoke)
    // would otherwise spawn a parallel socket.
    if (connecting) return;
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    teardownWs();
    // `connecting` is held across the async ticket mint AND the socket open,
    // so a queued reconnect or double-invoke cannot start a parallel attempt
    // while the mint is in flight.
    connecting = true;
    setStatus("connecting...");
    void openWithTicket();
  }

  // Mint a ticket, then open the socket with `?ticket=`. Kept separate from
  // connect() so connect() stays a synchronous guard. A mint failure (network
  // blip, expired surface) is treated like a connection failure: clear the
  // in-flight flag and schedule a backed-off reconnect.
  async function openWithTicket(): Promise<void> {
    let ticket: string;
    try {
      ticket = await mintTicket();
    } catch {
      connecting = false;
      scheduleReconnect();
      return;
    }
    // The surface may have closed, or a newer connect superseded us, while the
    // mint was in flight — bail rather than open a doomed socket.
    if (CFG.isClosed) {
      connecting = false;
      return;
    }
    let qs = "?ticket=" + encodeURIComponent(ticket);
    if (lastEventId > 0) qs += "&since=" + lastEventId;
    // #296 — auto-subscribe to every declared record collection. The relay
    // (#295) expands `subscribe_records=*` against the surface's
    // recordSchema; a surface with no record_schema gets an empty list and
    // sees no record traffic. On reconnect, advance each collection's
    // cursor from the store so the relay's replay skips already-observed
    // rows.
    qs += "&subscribe_records=*";
    const cursorQs = recordStore.reconnectCursorQuery();
    if (cursorQs.length > 0) qs += "&" + cursorQs;
    const sock = new WebSocket(CFG.wsUrl + qs);
    ws = sock;

    sock.addEventListener("open", () => {
      if (ws !== sock) return; // superseded
      connecting = false;
      backoff = 1000;
      setStatus("connected", "up");
    });

    sock.addEventListener("message", (evt: MessageEvent) => {
      if (ws !== sock) return; // superseded socket — ignore late frames
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg && msg["kind"] === "system.replay.complete") {
        replayDone = true;
        sendIframeInit();
        return;
      }
      // #296 — record-delta routing. record.replay.complete is a per-collection
      // handshake sentinel from the relay's #295 path; the shell uses it to
      // mark the collection as fully synced but otherwise drops it (no
      // forwarding into the iframe needed today — #298's runtime API can
      // expose a `.ready` promise if it wants one). record.upsert and
      // record.delete fold into the store; the iframe-postMessage routing
      // for these is #298's scope.
      const kind = msg["kind"];
      if (kind === "record.upsert") {
        const delta = recordStore.applyUpsert(
          msg as unknown as Parameters<RecordStore["applyUpsert"]>[0],
        );
        // #298 — forward only non-stale deltas to the iframe so pane.records.on
        // fires once per real change (the store returns null on stale-seq).
        if (delta) {
          pushRecordDeltaToIframe(
            "upsert",
            delta.collection,
            (delta as { record: unknown }).record,
          );
        }
        return;
      }
      if (kind === "record.delete") {
        const delta = recordStore.applyDelete(
          msg as unknown as Parameters<RecordStore["applyDelete"]>[0],
        );
        if (delta) {
          pushRecordDeltaToIframe(
            "delete",
            delta.collection,
            (delta as { record: unknown }).record,
          );
        }
        return;
      }
      if (kind === "record.replay.complete") {
        // Sentinel — store already advanced via the replayed deltas above it.
        return;
      }
      if (msg && msg["error"]) {
        if (
          validCid(msg["correlation_id"]) &&
          iframeReady &&
          frame &&
          frame.contentWindow
        ) {
          const errFrame: OutboundFrame = {
            __pane: 1,
            v: 1,
            kind: "error",
            correlation_id: msg["correlation_id"],
            error: msg["error"],
          };
          frame.contentWindow.postMessage(errFrame, IFRAME_ORIGIN);
        }
        return;
      }
      if (msg && msg["ack"] !== undefined) {
        if (
          validCid(msg["correlation_id"]) &&
          iframeReady &&
          frame &&
          frame.contentWindow
        ) {
          const ackFrame: OutboundFrame = {
            __pane: 1,
            v: 1,
            kind: "ack",
            correlation_id: msg["correlation_id"],
            event_id: msg["ack"],
            deduped: !!msg["deduped"],
          };
          frame.contentWindow.postMessage(ackFrame, IFRAME_ORIGIN);
        }
        return;
      }
      if (msg && msg["id"]) {
        // TODO(perf,phase-4): event ids are stringified on the wire; here we
        // coerce back to Number, which silently loses precision above 2^53.
        // Tracked alongside issue #23 (Postgres @db.BigInt migration).
        const n = Number(msg["id"]);
        if (isFinite(n) && n > lastEventId) lastEventId = n;
        if (!replayDone) {
          // Replayed (historical) events do NOT update presence: a lost `left`
          // would leave a stale `joined` claiming an agent is connected. Live
          // presence comes only from CFG (seed) + post-replay events below.
          replayBuffer.push(msg as unknown as SerializedEvent);
        } else {
          // Live event — fold it into presence and re-render the pill.
          trackLiveAgentPresence(msg as unknown as SerializedEvent);
          renderAgentPresence();
          pushToIframe(msg as unknown as SerializedEvent);
        }
      }
    });

    sock.addEventListener("close", () => {
      // Ignore a close from a socket we already replaced — only the live
      // socket's close should drive a reconnect, otherwise a stale socket
      // closing late would queue an extra (parallel) reconnect.
      if (ws !== sock) return;
      ws = null;
      connecting = false;
      scheduleReconnect();
    });

    sock.addEventListener("error", () => {
      // The close event always follows an error and is where the reconnect is
      // scheduled — nothing to do here.
    });
  }

  window.addEventListener("message", (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const m = e.data;
    // Reject anything that is not a current-version Pane frame: wrong marker
    // OR wrong protocol version `v`. The frame shape is defined in
    // ./protocol.ts and shared with the runtime bundle (issue #58).
    if (!m || typeof m !== "object" || m.__pane !== 1 || m.v !== 1) return;
    if (m.kind === "ready") {
      iframeReady = true;
      sendIframeInit();
      // #298 — push the initial record snapshot right after init so the
      // template's first pane.records.snapshot() reflects the replayed state.
      pushRecordSnapshotToIframe();
      return;
    }
    // upload-attachment-request: the iframe is asking the shell to POST a file to
    // the participant-side attachment upload route on its behalf. The shell owns
    // the participant token (it lives only in the shell, never reaches the
    // iframe) so the iframe cannot make this request directly. We fetch,
    // then post the result back. ALWAYS post a reply, even on network
    // failure — otherwise the iframe's promise sits hanging until its
    // 2-minute timeout. Follow-up C of #156.
    if (m.kind === "upload-attachment-request") {
      const uploadId =
        typeof m.id === "string" && m.id.length > 0 && m.id.length <= 128
          ? m.id
          : null;
      const file = m.file;
      // postMessage's structured clone preserves File instances; if it's
      // not actually a File the iframe sent us garbage and we should fail
      // the RPC rather than try a coerced upload.
      if (!uploadId || !(file instanceof File)) {
        if (uploadId && frame && frame.contentWindow) {
          const errFrame: OutboundFrame = {
            __pane: 1,
            v: 1,
            kind: "upload-attachment-result",
            id: uploadId,
            ok: false,
            error: {
              code: "invalid_request",
              message: "upload-attachment-request requires { id, file }",
            },
          };
          frame.contentWindow.postMessage(errFrame, IFRAME_ORIGIN);
        }
        return;
      }

      const opts = (m.options || {}) as {
        filename?: unknown;
        mime?: unknown;
      };
      // Re-wrap the File so the declared MIME override from `options.mime`
      // travels with the multipart part. The `new File([file], ...)`
      // form re-uses the underlying byte buffer — no copy on this path.
      const filename =
        typeof opts.filename === "string" ? opts.filename : file.name;
      const mime = typeof opts.mime === "string" ? opts.mime : file.type;
      const fd = new FormData();
      // `new File([file], ...)` would copy in some older browsers; pass the
      // existing File directly when no overrides were requested so common
      // path stays zero-copy.
      const part =
        typeof opts.mime === "string"
          ? new File([file], filename, { type: mime })
          : file;
      fd.set("file", part, filename);
      if (typeof opts.filename === "string") fd.set("filename", opts.filename);

      const uploadUrl = window.location.origin + CFG.attachmentsUploadUrl;

      // Fire the fetch in a sibling task — never await it on the message
      // listener thread, so a hung relay can't block other runtime frames.
      void (async () => {
        let res: Response;
        try {
          res = await fetch(uploadUrl, { method: "POST", body: fd });
        } catch (e) {
          if (frame && frame.contentWindow) {
            const reply: OutboundFrame = {
              __pane: 1,
              v: 1,
              kind: "upload-attachment-result",
              id: uploadId,
              ok: false,
              error: {
                code: "network_error",
                message:
                  e instanceof Error ? e.message : "network request failed",
              },
            };
            frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
          }
          return;
        }

        if (res.ok) {
          // 2xx — parse the AttachmentRef and resolve.
          let attachment: unknown;
          try {
            attachment = await res.json();
          } catch {
            attachment = null;
          }
          if (frame && frame.contentWindow) {
            const reply: OutboundFrame = {
              __pane: 1,
              v: 1,
              kind: "upload-attachment-result",
              id: uploadId,
              ok: true,
              attachment,
            };
            frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
          }
          return;
        }

        // Non-2xx — parse the standard {error: {code, message, hint, ...}}
        // envelope and forward it so the template's catch handler can
        // branch on the relay's error code.
        let code = "upload_failed";
        let message = "upload failed with status " + res.status;
        try {
          const body = (await res.json()) as {
            error?: { code?: unknown; message?: unknown };
          };
          if (body && body.error) {
            if (typeof body.error.code === "string") code = body.error.code;
            if (typeof body.error.message === "string")
              message = body.error.message;
          }
        } catch {
          /* response wasn't JSON — keep the synthetic message */
        }
        if (frame && frame.contentWindow) {
          const reply: OutboundFrame = {
            __pane: 1,
            v: 1,
            kind: "upload-attachment-result",
            id: uploadId,
            ok: false,
            error: { code, message },
          };
          frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
        }
      })();
      return;
    }
    // download-attachment-request: the iframe is asking the shell to GET attachment
    // bytes by id. The shell brokers this fetch — the iframe sandbox has
    // `connect-src 'none'` and the cookie / participant token never reach
    // the iframe, so it cannot make the request directly. We fetch, then
    // post the resulting Blob back via
    // structured clone — the iframe receives a live Blob it can render
    // with `URL.createObjectURL` (the iframe CSP allows `attachment:` URLs in
    // `img-src`). ALWAYS post a reply, even on network failure — otherwise
    // the iframe's promise sits hanging until its 2-minute timeout.
    // Follow-up D of #156. Symmetric to upload-attachment-request.
    if (m.kind === "download-attachment-request") {
      const downloadId =
        typeof m.id === "string" && m.id.length > 0 && m.id.length <= 128
          ? m.id
          : null;
      const attachmentId =
        typeof m.attachment_id === "string" &&
        m.attachment_id.length > 0 &&
        m.attachment_id.length <= 64
          ? m.attachment_id
          : null;
      if (!downloadId || !attachmentId) {
        if (downloadId && frame && frame.contentWindow) {
          const errFrame: OutboundFrame = {
            __pane: 1,
            v: 1,
            kind: "download-attachment-result",
            id: downloadId,
            ok: false,
            error: {
              code: "invalid_request",
              message:
                "download-attachment-request requires { id, attachment_id }",
            },
          };
          frame.contentWindow.postMessage(errFrame, IFRAME_ORIGIN);
        }
        return;
      }

      const downloadUrl =
        window.location.origin +
        CFG.attachmentsDownloadUrlBase +
        "/" +
        encodeURIComponent(attachmentId);

      // Fire the fetch in a sibling task — never await on the message
      // listener thread so a hung relay can't block other runtime frames.
      void (async () => {
        let res: Response;
        try {
          // `cache: 'no-store'` matches the route's `Cache-Control: private,
          // no-store` — participant-token-authed bytes must never be
          // cached by the browser.
          res = await fetch(downloadUrl, {
            credentials: "same-origin",
            cache: "no-store",
          });
        } catch (e) {
          if (frame && frame.contentWindow) {
            const reply: OutboundFrame = {
              __pane: 1,
              v: 1,
              kind: "download-attachment-result",
              id: downloadId,
              ok: false,
              error: {
                code: "fetch_error",
                message:
                  e instanceof Error ? e.message : "network request failed",
              },
            };
            frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
          }
          return;
        }

        if (res.ok) {
          let blobBody: Blob;
          try {
            blobBody = await res.blob();
          } catch (e) {
            if (frame && frame.contentWindow) {
              const reply: OutboundFrame = {
                __pane: 1,
                v: 1,
                kind: "download-attachment-result",
                id: downloadId,
                ok: false,
                error: {
                  code: "fetch_error",
                  message:
                    e instanceof Error ? e.message : "could not read body",
                },
              };
              frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
            }
            return;
          }
          if (frame && frame.contentWindow) {
            const reply: OutboundFrame = {
              __pane: 1,
              v: 1,
              kind: "download-attachment-result",
              id: downloadId,
              ok: true,
              attachment: blobBody,
              mime: blobBody.type,
              size: blobBody.size,
            };
            frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
          }
          return;
        }

        // Non-2xx — parse the standard {error: {code, message, ...}}
        // envelope and forward so the template can branch on the code.
        let code = "download_failed";
        let message = "download failed with status " + res.status;
        try {
          const body = (await res.json()) as {
            error?: { code?: unknown; message?: unknown };
          };
          if (body && body.error) {
            if (typeof body.error.code === "string") code = body.error.code;
            if (typeof body.error.message === "string")
              message = body.error.message;
          }
        } catch {
          /* response wasn't JSON — keep the synthetic message */
        }
        if (frame && frame.contentWindow) {
          const reply: OutboundFrame = {
            __pane: 1,
            v: 1,
            kind: "download-attachment-result",
            id: downloadId,
            ok: false,
            error: { code, message },
          };
          frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
        }
      })();
      return;
    }
    // save-attachment-request: iframe asks the shell to trigger a browser save of
    // a attachment. Distinct from download-attachment-request — no bytes flow back to
    // the iframe. The shell performs the `<a download>` click in its OWN
    // (non-sandboxed) document, which is the only way iOS WebKit reliably
    // saves files; sandboxed-iframe downloads are silently dropped on iOS
    // even with `allow-downloads`. Always replies with ok | error so the
    // iframe's promise resolves.
    if (m.kind === "save-attachment-request") {
      const saveId =
        typeof m.id === "string" && m.id.length > 0 && m.id.length <= 128
          ? m.id
          : null;
      const attachmentId =
        typeof m.attachment_id === "string" &&
        m.attachment_id.length > 0 &&
        m.attachment_id.length <= 64
          ? m.attachment_id
          : null;
      // Sanitise filename — strip path separators and control chars, cap len.
      let fname: string | null = null;
      if (typeof m.filename === "string" && m.filename.length > 0) {
        const cleaned = m.filename
          // eslint-disable-next-line no-control-regex
          .replace(/[/\\\x00-\x1f]/g, "_")
          .slice(0, 200);
        if (cleaned.length > 0) fname = cleaned;
      }

      if (!saveId || !attachmentId) {
        if (saveId && frame && frame.contentWindow) {
          const errFrame: OutboundFrame = {
            __pane: 1,
            v: 1,
            kind: "save-attachment-result",
            id: saveId,
            ok: false,
            error: {
              code: "invalid_request",
              message: "save-attachment-request requires { id, attachment_id }",
            },
          };
          frame.contentWindow.postMessage(errFrame, IFRAME_ORIGIN);
        }
        return;
      }

      const downloadUrl =
        window.location.origin +
        CFG.attachmentsDownloadUrlBase +
        "/" +
        encodeURIComponent(attachmentId);

      // Fire in a sibling task — never await on the message-listener thread.
      void (async () => {
        let res: Response;
        try {
          res = await fetch(downloadUrl, {
            credentials: "same-origin",
            cache: "no-store",
          });
        } catch (e) {
          if (frame && frame.contentWindow) {
            const reply: OutboundFrame = {
              __pane: 1,
              v: 1,
              kind: "save-attachment-result",
              id: saveId,
              ok: false,
              error: {
                code: "fetch_error",
                message:
                  e instanceof Error ? e.message : "network request failed",
              },
            };
            frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
          }
          return;
        }

        if (!res.ok) {
          let code = "save_failed";
          let message = "save failed with status " + res.status;
          try {
            const body = (await res.json()) as {
              error?: { code?: unknown; message?: unknown };
            };
            if (body && body.error) {
              if (typeof body.error.code === "string") code = body.error.code;
              if (typeof body.error.message === "string")
                message = body.error.message;
            }
          } catch {
            /* not JSON */
          }
          if (frame && frame.contentWindow) {
            const reply: OutboundFrame = {
              __pane: 1,
              v: 1,
              kind: "save-attachment-result",
              id: saveId,
              ok: false,
              error: { code, message },
            };
            frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
          }
          return;
        }

        // Build a temporary <a download> in the OUTER document, click it,
        // remove. This is the load-bearing part of the workaround — iOS
        // WebKit honours the `download` attribute here but not from inside
        // a sandboxed iframe even with `allow-downloads`.
        try {
          const blobBody = await res.blob();
          const objectUrl = URL.createObjectURL(blobBody);
          const a = document.createElement("a");
          a.href = objectUrl;
          a.download = fname || attachmentId;
          // Some browsers need the anchor to be in the DOM before .click()
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          // Schedule cleanup — keep the URL alive briefly so the browser
          // has time to start the download even if the user is on a slow
          // connection.
          setTimeout(() => {
            try {
              a.remove();
            } catch {
              /* ignore */
            }
            URL.revokeObjectURL(objectUrl);
          }, 1500);

          if (frame && frame.contentWindow) {
            const reply: OutboundFrame = {
              __pane: 1,
              v: 1,
              kind: "save-attachment-result",
              id: saveId,
              ok: true,
            };
            frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
          }
        } catch (e) {
          if (frame && frame.contentWindow) {
            const reply: OutboundFrame = {
              __pane: 1,
              v: 1,
              kind: "save-attachment-result",
              id: saveId,
              ok: false,
              error: {
                code: "save_failed",
                message:
                  e instanceof Error ? e.message : "failed to trigger save",
              },
            };
            frame.contentWindow.postMessage(reply, IFRAME_ORIGIN);
          }
        }
      })();
      return;
    }
    if (m.kind === "emit") {
      // The runtime always attaches correlation_id, so any failure path here
      // MUST reply with a synthetic error frame — otherwise pane.emit()'s
      // Promise sits hanging until the 30s timeout fires.
      const replyError = (code: string, message: string): void => {
        if (!validCid(m.correlation_id) || !frame || !frame.contentWindow)
          return;
        const errFrame: OutboundFrame = {
          __pane: 1,
          v: 1,
          kind: "error",
          correlation_id: m.correlation_id,
          error: { code, message },
        };
        frame.contentWindow.postMessage(errFrame, IFRAME_ORIGIN);
      };
      if (typeof m.type !== "string" || !m.type.length || m.type.length > 64) {
        replyError(
          "invalid_request",
          "type must be a non-empty string within 64 chars",
        );
        return;
      }
      const out: Record<string, unknown> = {
        type: m.type,
        data: m.data,
      };
      if (typeof m.causation_id === "string" && m.causation_id.length <= 64) {
        out["causation_id"] = m.causation_id;
      }
      if (
        typeof m.idempotency_key === "string" &&
        m.idempotency_key.length <= 128
      ) {
        out["idempotency_key"] = m.idempotency_key;
      }
      if (validCid(m.correlation_id)) out["correlation_id"] = m.correlation_id;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(out));
      } else {
        replyError("disconnected", "WebSocket is not open");
      }
      return;
    }
  });

  connect();
})();
