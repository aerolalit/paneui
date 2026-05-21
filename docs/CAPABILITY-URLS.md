# Capability URLs (`/b/<token>`)

Tracking issue: [#155](https://github.com/aerolalit/paneui/issues/155) — verifies the hardening claims below.

Pane's `/b/<token>` endpoint serves a blob's bytes without an agent API
key or a participant session token. **The URL token IS the credential.**
This is a capability URL. Capability URLs are useful — they let a human
view a private image by clicking a link — but they have well-documented
failure modes (the same ones every S3 presigned URL or Google Docs
"anyone with the link" share has).

This document tells you what the surface is, what we defend against,
and what to do about the gaps.

## What a `/b/<token>` URL grants

A holder of `https://relay.example.com/b/paneb_<32-base64url-chars>` can:

- `GET` the bytes of one specific blob, until:
  - the token expires, OR
  - the token is revoked, OR
  - the token is a `once` token and has been used.

That's it. The token does NOT grant:
- Access to any other blob
- Listing of blobs
- Upload / mint / revoke (those need an agent API key)
- Knowledge of who minted it or when it was first used (the metadata
  is agent-only via `pane blob show`)

## Where these URLs leak in practice

We assume the following, regardless of our defences. Treat any of these
as plausible:

- **Browser history.** A user opens the URL; it goes into history. Their
  partner uses the same laptop; types `relay.paneui.com` into the bar;
  autocomplete reveals the path.
- **Screenshots / screen sharing.** A support call where the user shares
  their screen reveals the URL in the address bar.
- **Copy-paste into chat.** "Look at this picture" pasted into Slack /
  Discord / a public Discord channel.
- **Email forwarding.** "Forward this to my colleague" forwards the URL.
- **Proxy / load-balancer logs.** Pane redacts tokens at the relay's
  access log; an upstream LB or WAF might not.
- **Search-engine indexing.** Don't ever link these from indexed pages.
- **Referer headers.** Without `Referrer-Policy: no-referrer`, the
  next-page navigation leaks the URL to the destination.

## What pane's defences cover

| Defence | Purpose | Coverage |
|---------|---------|----------|
| 192-bit token entropy (`paneb_` + 32 base64url chars) | unguessable | universe is unguessable; doesn't help once leaked |
| Scope-bound TTL (30d artifact / session-TTL / 24h agent) | bounded exposure window | leaked URL stops working at expiry |
| `--once` flag | single-shot tokens for sensitive sharing | self-deletes on first GET |
| Revocation endpoint + in-process cache | instant kill switch on leak | < 1s propagation; DB is source of truth |
| `Referrer-Policy: no-referrer` on every blob response | block cross-origin leak | the next-page navigation can't leak the URL |
| `X-Content-Type-Options: nosniff` | force declared MIME | browser won't reclassify image bytes as HTML |
| `Content-Disposition: attachment` for non-image MIMEs | block inline render | PDF / etc. download instead of display |
| `Cross-Origin-Resource-Policy: same-origin` | block speculative cross-origin reads | only pane's own origin can fetch |
| `Cache-Control: private, no-store` | block shared-cache caching | CDN / corporate proxy won't cache |
| Access-log token redaction (`/b/***`) | logs don't leak the URL | tokens never reach an aggregator unredacted |
| Per-token audit metadata (/24-truncated IPs, use_count) | spot anomalous use | the owner can see "this token started getting used from a different network" |

## What pane's defences do NOT cover

Anything that happens **after the URL leaves pane's control**. Once the
URL is in someone's chat / clipboard / email, we cannot un-tell them.
The defences above bound the blast radius; they don't prevent leaks.

## Decision tree: which kind of token to mint

```
              Is the blob sensitive (private docs, personal photos)?
                 ┌────────────────┴────────────────┐
                NO                                YES
                 │                                 │
       Need participant-side access?      Need it more than once?
       ┌──────────┴──────────┐            ┌────────┴───────┐
      NO                    YES          NO                YES
       │                     │            │                 │
   Use the                Session-     `--once` token    Agent-scope blob
   authenticated          scope blob   (5-min TTL)       + agent-scope
   GET /v1/blobs/:id      with         + encryption-at-  token (24h, can
   from agent code        session-     rest opt-in.      be re-minted
   only — never           scope token  Re-mint per       any time)
   /b/<token>             that dies    download.
                          with the
                          session.
```

### When to use `--once`

- The blob is sensitive and you're sharing it with exactly one human.
- Any subsequent use after the first download is suspicious — better to
  fail-closed than re-serve.
- Examples: a private medical document, a one-time backup link, a
  confidential agent response.

### When NOT to use `--once`

- You want the human to be able to refresh / re-open the page that
  embeds the blob (`<img src=/b/...>`).
- The blob is benign (a public-ish UI icon, a chart).

### When to set encryption-at-rest

The hosted Pane relay leaves `BLOB_ENCRYPT_AT_REST` off — Azure Blob's
native at-rest encryption is the floor. Self-hosters on a single VM with
sensitive content should set:

```
BLOB_ENCRYPT_AT_REST=true
```

This wraps each blob with a per-blob random DEK encrypted under
`PANE_SECRET_KEY` (AES-256-GCM). An attacker who reads the raw blob
files from disk cannot decrypt them without the master key.

What this does NOT defend against:
- Relay compromise. If the attacker has the master key, every blob is
  readable. (Customer-managed keys are v2.)
- Master-key loss. Without `PANE_SECRET_KEY`, encrypted blobs are
  unrecoverable. **Back the key up.**

## How to audit a token's usage

```sh
# Show all tokens for a blob, including audit metadata.
pane blob show <blob_id>

# Output includes per-token:
#   * created_at, expires_at
#   * use_count, last_used_at
#   * first_seen_ip_net, last_seen_ip_net  (/24-truncated IPv4 or /48 IPv6)
#   * revoked_at
```

Things to watch for:
- `first_seen_ip_net` ≠ `last_seen_ip_net` — the token is being used
  from two different ISPs / networks. Possibly fine (work + home), or
  the URL leaked.
- `use_count` higher than you expected — the page that embeds the URL
  is fetching it more than the human is viewing it.
- `last_used_at` from a long time ago — the token might be stale; can
  be re-minted with a shorter TTL or `--once`.

## If a token leaks: runbook

See [`docs/RUNBOOK-LEAKED-TOKEN.md`](./RUNBOOK-LEAKED-TOKEN.md).

## Participant uploads (`POST /s/:participantToken/blobs`)

The agent-side upload path is `POST /v1/blobs` with an agent API key. To
close the round-trip — so a human inside a rendered pane can upload a
file BACK to the agent (a selfie, a PDF, a CSV) — the relay also accepts
multipart uploads on `POST /s/:participantToken/blobs` authenticated by
the participant token alone.

The iframe shim exposes this as `window.pane.uploadBlob(file, options?)`.
The shell (the participant-facing page that holds the token) brokers the
fetch and returns a `BlobRef` to the iframe via postMessage. The agent
then receives the BlobRef as part of a normal `pane.emit(...)` event
payload and can download the bytes via the existing
`/v1/blobs/:id` route or by minting a `/b/<token>` URL.

### Threat model

- **Auth.** The participant token in the path IS the credential. There is
  no second factor. The token's surface is the same one already used by
  the WebSocket-ticket mint, the presence-poll endpoint, and the event-
  emit channel — so participant uploads inherit the same trust posture
  as event emits. A leaked participant token already lets the holder
  emit forged events; the upload path doesn't widen that.
- **Scope pinning.** Scope is FORCED to `session`. Even if the multipart
  body carries `scope=agent` or `scope=artifact`, the route ignores
  those values. A human cannot mint long-lived agent-scope blobs through
  a participant token, and cannot reach an artifact they don't own.
  Session-scope blobs cascade-delete with the session, which bounds the
  blast radius of a leaked participant token: when the agent ends the
  session, the human's uploads go with it.
- **Quota accounting.** Uploads count against the OWNING AGENT's quota
  (`MAX_BLOBS_PER_AGENT_BYTES`), not the participant. The Blob row's
  `ownerId` is `session.agentId`. This means a hostile / runaway
  participant can DoS the agent's quota; agents should keep an eye on
  `pane blob list` and/or set conservative per-session caps with
  `MAX_BLOBS_PER_SESSION_BYTES`.
- **Pipeline parity.** The participant route runs the EXACT same pipeline
  as `POST /v1/blobs` — MIME sniff, polyglot defense via sharp, EXIF
  strip, envelope encryption-at-rest, scan webhook. The shared
  implementation lives in `packages/relay/src/blobs/upload-pipeline.ts`
  so the two routes can't drift.

### Wire shape

```
POST /s/<participantToken>/blobs
Content-Type: multipart/form-data; boundary=...

  file       — required, the binary file part
  filename   — optional UX-only display name
```

Response: a `BlobRef` (same shape `POST /v1/blobs` returns).

Errors are the standard envelope `{error: {code, message, hint, retryable, docs_url}}`:

| HTTP | code | meaning |
|------|------|---------|
| 400  | `invalid_request` | missing `file` part / empty body |
| 401  | `participant_token_invalid` | malformed / unknown / revoked token |
| 410  | `gone` | the session is closed or expired |
| 413  | `blob_size_exceeded` | upload > `MAX_BLOB_BYTES` |
| 413  | `quota_exceeded` | the agent's aggregate quota is full |
| 415  | `mime_mismatch` | declared Content-Type disagrees with sniffed |
| 415  | `mime_disallowed` | sniffed MIME not in `BLOB_MIME_ALLOWLIST` |

## Related

- [`docs/SECURITY-POLYGLOTS.md`](./SECURITY-POLYGLOTS.md) — polyglot defence
- [`docs/BLOB_BACKENDS.md`](./BLOB_BACKENDS.md) — backend compatibility
- [`docs/RUNBOOK-LEAKED-TOKEN.md`](./RUNBOOK-LEAKED-TOKEN.md) — incident response
- Proposal: [pane#152](https://github.com/aerolalit/paneui/issues/152)
- Verification tracking: [pane#155](https://github.com/aerolalit/paneui/issues/155)
