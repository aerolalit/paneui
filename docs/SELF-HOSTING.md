# Self-hosting Pane

Run your own Pane relay in one container, backed by a SQLite file. No Postgres,
no container registry, no clone — pull the published image and run it.

This is the right path for a solo or small-team relay. If you are running Pane
as scaled infrastructure (Postgres, multiple replicas, observability, a managed
cloud deploy), see [DEPLOY.md](DEPLOY.md) instead.

## What you deploy

Only the **relay**. A prebuilt image is published to the GitHub Container
Registry on every release:

```
ghcr.io/aerolalit/paneui:<version>     # e.g. :0.1.0 — pin this for reproducible deploys
ghcr.io/aerolalit/paneui:latest
```

The image bundles the human-facing web UI (the `/s/:token` shell page), so
there is no separate frontend to deploy. The `pane` CLI runs wherever your
agent runs — it is not part of the deployment.

SQLite is the default and recommended store for a self-host: one file, no
separate service. (A `-postgres` image variant exists for the scaled path —
see [DEPLOY.md](DEPLOY.md). For a single-box self-host, stay on SQLite.)

## The env vars you need

A solo relay needs only a handful:

| Var | Required | Notes |
|-----|----------|-------|
| `NODE_ENV` | yes | Set to `production` — turns on the startup safety checks. |
| `PUBLIC_URL` | yes | The public HTTPS URL the relay is reached at. Every human session URL is built from it; if it's wrong, those URLs are unreachable. The relay refuses to start in production if it's unset or points at `localhost`. |
| `PANE_SECRET_KEY` | yes | 32-byte encryption key — `openssl rand -base64 32`. See [The encryption key](#the-encryption-key) below. |
| `API_KEY` | recommended | Bootstraps your agent's key. If unset, the relay mints one on first boot and prints it once in the logs. |
| `PORT` | no | Defaults to `3000`. |
| `REGISTRATION_MODE` | no | Defaults to `closed` — leave it unless you want other agents to self-register a key. See [DEPLOY.md](DEPLOY.md#registration-mode). |

The full env-var reference is [`packages/relay/.env.example`](../packages/relay/.env.example).

## docker compose (quickest)

The repo ships a [`docker-compose.yml`](../docker-compose.yml) that pulls the
GHCR image. Copy **just that file** into an empty directory (no clone needed)
and create a `.env` next to it:

```bash
NODE_ENV=production
PUBLIC_URL=https://pane.example.com      # your public URL
PANE_SECRET_KEY=                         # openssl rand -base64 32
API_KEY=pane_xxxxxxxxxxxxxxxxxxxxxxxx    # optional; bootstraps your agent key
# REGISTRATION_MODE defaults to closed — leave unset unless you want self-service
```

Then:

```bash
docker compose up -d
```

Migrations run automatically on boot, a named volume (`pane-data`) persists the
SQLite database at `/app/data` across restarts, and compose runs a
`GET /healthz` healthcheck. Upgrade with `docker compose pull && docker compose up -d`.

## docker run (without compose)

```bash
docker run -d -p 3000:3000 \
  -e NODE_ENV=production \
  -e PUBLIC_URL=https://pane.example.com \
  -e PANE_SECRET_KEY="$(openssl rand -base64 32)" \
  -e API_KEY=pane_xxxxxxxxxxxxxxxxxxxxxxxx \
  -v pane-data:/app/data \
  ghcr.io/aerolalit/paneui:latest
```

## Building from source

If you are modifying Pane or want an unreleased build, build the image from a
checkout instead of pulling it (`docker-compose.yml` also has a commented
`build:` block):

```bash
docker build -f packages/relay/Dockerfile -t pane .   # build context = repo root
```

To run the relay straight from source without Docker:

```bash
npm install
npm run build  --workspace @paneui/relay
npm run migrate:deploy --workspace @paneui/relay
NODE_ENV=production PUBLIC_URL=... PANE_SECRET_KEY=... \
  npm run start --workspace @paneui/relay
```

## TLS and reverse proxy

The relay speaks plain HTTP on `PORT`. For anything internet-facing, put a
reverse proxy (Caddy, nginx, Traefik) in front to terminate TLS. The proxy
**must forward WebSocket upgrades** for `/v1/sessions/:id/stream`, and
`PUBLIC_URL` must exactly match the public scheme + host the proxy serves — the
relay bakes it into every participant URL and the WebSocket CSP origin.

## Blob attachments

The relay accepts file attachments (images, audio, video, PDF — full allowlist
in [BLOB_BACKENDS.md](BLOB_BACKENDS.md)) from agents and humans. The single-box
self-host runs the **filesystem backend** with no extra setup: the published
image pins `BLOB_STORE_FS_DIR=/app/data/blobs`, so blobs land in the same
`/app/data` volume as the SQLite DB and persist across restarts. Files on disk
are mode `0600`; the relay refuses to start if the directory exists with
world-readable permissions.

You only need to tune env vars if you want different limits:

| Var | Default | Notes |
|-----|---------|-------|
| `MAX_BLOB_BYTES` | `5_000_000` | Per-blob ceiling (5 MB). |
| `MAX_BLOBS_PER_SESSION_BYTES` | `100_000_000` | Aggregate per session (100 MB). |
| `MAX_BLOBS_PER_AGENT_BYTES` | `500_000_000` | Aggregate across all of one agent's blobs (500 MB). |
| `BLOB_ENCRYPT_AT_REST` | `false` | Envelope-encrypt blobs on disk with `PANE_SECRET_KEY`. Adds latency; turn on if the host disk isn't already encrypted. |
| `BLOB_MIME_ALLOWLIST` | `image/jpeg,image/png,image/gif,image/webp,application/pdf` | Comma-separated MIME prefixes. The pipeline also sniffs file content — the declared MIME is never trusted. SVG is excluded by default (XSS vector). Empty/unset falls back to this default (never accept-any); set `*` to accept any sniffed MIME. |

The filesystem backend is **single-VM only**: replicas see different disks. If
you outgrow one box, switch to the Azure Blob backend — see
[BLOB_BACKENDS.md](BLOB_BACKENDS.md) and [DEPLOY.md](DEPLOY.md#blob-storage).

## The encryption key

Pane encrypts secrets at rest (currently webhook callback secrets) with an
AES-256-GCM master key, `PANE_SECRET_KEY`.

Generate one with:

```bash
openssl rand -base64 32
```

**Keep it stable for the life of the deployment, and back it up.** In
development the relay auto-generates a key file if `PANE_SECRET_KEY` is unset;
in production that auto-generate is disabled and the relay refuses to start
without one — a container's filesystem is ephemeral, so a generated file would
not survive a restart and every restart would mint a fresh key, making all
previously-encrypted data permanently undecryptable. There is no key-rotation
mechanism: changing the key orphans everything encrypted under the old one.

## Getting your agent a key

With `REGISTRATION_MODE` at its default (`closed`), no one can self-register.
Provide your agent's key via `API_KEY`, or let the relay mint one on first boot
and read it from the logs (`docker compose logs`). Only open `secret`/`open`
registration if you actually want other agents to provision themselves — see
[Registration mode in DEPLOY.md](DEPLOY.md#registration-mode).

## Use it

Point the CLI at your relay and do a round trip:

```bash
PANE_URL=https://pane.example.com PANE_API_KEY=<your key> \
  pane session create --artifact ./form.html --schema ./schema.json --ttl 600
```

Or save the URL + key once with `pane agent register --url https://pane.example.com`,
after which every command works with no env vars.

## See also

- [DEPLOY.md](DEPLOY.md) — operator guide: Postgres, multi-replica scaling,
  observability, and the Azure Container Apps reference deployment.
- [`packages/relay/.env.example`](../packages/relay/.env.example) — the full
  env-var reference.
