# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue.

The preferred channel is **GitHub Private Vulnerability Reporting**:

1. Go to the [Security tab](https://github.com/aerolalit/paneui/security) of the `aerolalit/paneui` repository.
2. Click **"Report a vulnerability"**.
3. Describe the issue, including steps to reproduce and affected versions/components (`relay`, `cli`, or `core`).

GitHub then keeps the report in a private advisory thread that only you and the
maintainer can see.

If GitHub private reporting is unavailable to you, contact the repository owner
([`@aerolalit`](https://github.com/aerolalit)) through their GitHub profile and
ask for a private channel. (A dedicated security email address may be listed
here in the future; until then, GitHub private reporting is the canonical
channel.)

Please do not disclose the issue publicly until a fix is available and coordinated.

## What to expect

Pane is a small, pre-1.0 open-source project. We aim to:

- **Acknowledge** your report within **3 business days**.
- Provide an initial **assessment** within roughly **a week**.
- Keep you updated as a fix is developed, and credit you (if you wish) once it ships.

Timelines are best-effort, not contractual.

## Threat model / trust boundaries

This section describes what Pane's relay defends against, and — just as
importantly — what it deliberately does not. It reflects the relay as
implemented today (`packages/relay/src/`); it is not aspirational.

### Artifact trust boundary

The agent that creates a session authors the artifact's HTML and JavaScript.
The relay treats that artifact as **untrusted content** and renders it inside a
sandboxed iframe (`sandbox="allow-scripts"` — scripts run, but the frame has no
same-origin privileges, cannot navigate the top frame, submit forms, or open
popups). The artifact is served from `/s/:token/content` under a tight CSP:
`default-src 'none'`, `connect-src 'none'` (the artifact cannot make network
requests of any kind — no `fetch`, no `XMLHttpRequest`, no WebSocket), a
locked-down `Permissions-Policy` that denies every powerful browser API, and
`Referrer-Policy: no-referrer` on the shell. The artifact talks to the relay
**only** through the pane runtime's `postMessage` channel, which the shell
mediates.

What this buys you: a malicious or compromised artifact cannot exfiltrate the
human's data to an arbitrary endpoint, and cannot reach back into the relay or
the human's browser session beyond the bridge.

What it does **not** buy you: the artifact still controls what the human sees.
A compromised agent — or a third-party script the agent author chose to embed —
can socially-engineer the human (display misleading text, ask for information
the human shouldn't give, impersonate a trusted party). The sandbox stops code
exfiltration, not human deception. **Trusting the artifact's intent is the
agent author's responsibility, not the relay's.** This is an accepted part of
the model: Pane's job is to hand a human a UI from an agent, and the human's
trust in that UI is ultimately trust in the agent that sent the link.

### URL-token sensitivity

A human opens a session through `/s/:token`. That URL **is** the credential:
the token (43 chars of `randomBytes(32)` entropy) is the only thing
authenticating the request — there is no separate login, cookie, or per-request
secret. The shell page, the artifact body (`/s/:token/content`), and the
presence endpoint (`/s/:token/presence`) all authenticate purely by this token.

Consequences to be aware of:

- **Treat the participant URL like a password.** Anyone who obtains it can open
  the session and act as that participant. Avoid leaking it into shared logs,
  analytics, referrer headers (the relay sets `Referrer-Policy: no-referrer` to
  help here), or chat history that a wider audience can read.
- **There is no per-token revocation today.** The data model has a
  `revokedAt` field on participants and `loadByToken` honors it, but no API
  endpoint sets it. The only revocation primitive currently exposed is
  `DELETE /v1/sessions/:id`, which closes the **entire** session for **all**
  participants. You cannot currently invalidate one leaked participant link
  while keeping the session open for others.
- Tokens stop working when the session expires (`ttl`) or is deleted.

### Deployment caveat — `POST /v1/register`

`/v1/register` is an **open, unauthenticated** endpoint: it is the call that
*mints* an API key, so by design it carries no bearer credential. Abuse is
bounded only by a per-IP sliding-window rate limit (`REGISTER_RATE_LIMIT` /
`REGISTER_RATE_WINDOW_SECONDS`), and that limit is only meaningful if the relay
sees real client IPs.

**Do not expose `/v1/register` to the public internet without a trusted
reverse proxy in front of the relay.** Behind a proxy, the relay must be
configured to derive client IPs from the proxy's forwarded headers; without
that, every request appears to come from the proxy's IP and the rate limit
collapses to a single shared bucket. If you do not need open self-registration,
disable or block the endpoint at the proxy and provision API keys out of band.
Trusted-proxy / forwarded-IP configuration is tracked as future work on the roadmap.

### Blob attachment hardening

Pane's blob-attachment pane (uploads served via `/v1/blobs` and
`/b/<token>`) gets specific hardening on top of the general posture:

- **Polyglot defense** — every normalisable image (JPEG / PNG / GIF /
  WebP) is decoded and re-encoded through libvips (sharp). Appended
  payloads, in-format text chunks, and EXIF metadata are dropped on
  re-encode. See [`docs/SECURITY-POLYGLOTS.md`](./docs/SECURITY-POLYGLOTS.md)
  for the threat model, the tracked corpus, and the disclosure process
  for bypasses.
- **Capability-URL hardening** — `/b/<token>` URLs are revocable,
  scope-bound, and stripped from access logs. See
  [`docs/CAPABILITY-URLS.md`](./docs/CAPABILITY-URLS.md).
- **Backend conformance** — every blob store implementation (filesystem,
  Azure Blob) is run against a shared conformance suite covering
  presigned-PUT TOCTOU defense + size / checksum / single-use semantics.
  See [`docs/BLOB_BACKENDS.md`](./docs/BLOB_BACKENDS.md).
- **Leaked-token runbook** — [`docs/RUNBOOK-LEAKED-TOKEN.md`](./docs/RUNBOOK-LEAKED-TOKEN.md).

## Supported versions

Pane has **no formal releases yet**. Security fixes land on the latest `main` only.

| Version       | Supported          |
| ------------- | ------------------ |
| `main` (latest) | :white_check_mark: |
| Older commits   | :x:                |

Once tagged releases exist, this table will be updated to reflect the supported release line.
