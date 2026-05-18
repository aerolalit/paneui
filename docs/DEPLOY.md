# Deploying Pane

Pane runs as a **single-container** relay. This guide covers the hosted
reference deployment on **Azure Container Apps (ACA)** backed by Azure Database
for PostgreSQL. Self-hosting elsewhere (any container host) follows the same
shape — the env-var contract is the only thing that matters.

> **Single replica only.** The event fan-out is an in-process `EventEmitter`
> (`packages/relay/src/http/broadcast.ts`). Scaling past one replica silently
> drops cross-replica events. Pin `minReplicas = maxReplicas = 1`.

## Production preflight

In `NODE_ENV=production` the relay **fails fast at startup** on two
misconfigurations that would otherwise break silently. Both are enforced before
the HTTP port is bound (`packages/relay/src/index.ts`):

| Check | Why |
|-------|-----|
| `PANE_SECRET_KEY` must be set | See "Encryption master key" below. |
| `PUBLIC_URL` must be set and not `localhost`/`127.0.0.1` | See "PUBLIC_URL" below. |

In development neither is required — the relay auto-generates a key file and
defaults `PUBLIC_URL` to `http://localhost:PORT`.

## Environment variables

Full list in [`packages/relay/.env.example`](../packages/relay/.env.example).
The deployment-critical ones:

| Var | Required in prod | Notes |
|-----|------------------|-------|
| `NODE_ENV` | yes — set to `production` | Turns on the startup preflight. |
| `DATABASE_URL` | yes | Postgres connection string. |
| `PANE_SECRET_KEY` | yes | 32-byte AES key, base64 or hex. |
| `PUBLIC_URL` | yes | Public HTTPS URL the relay is reached at. |
| `API_KEY` | recommended | Bootstraps the default agent. If unset, one is minted and printed once at boot. |
| `REGISTRATION_MODE` | no | `closed` (default) · `secret` · `open` — controls `POST /v1/register`. See "Registration mode" below. |
| `REGISTRATION_SECRET` | when `REGISTRATION_MODE=secret` | Shared bearer secret callers must present. Boot fails fast if the mode is `secret` and this is unset. |
| `PORT` | no | Defaults to `3000`. |

## Registration mode

`POST /v1/register` — how agents self-provision a key — is gated by
`REGISTRATION_MODE`. It is **closed by default**: a freshly deployed relay does
not expose self-service registration to anyone.

| `REGISTRATION_MODE` | Behavior | Use it for |
|---------------------|----------|------------|
| `closed` *(default)* | Endpoint returns `404`. Agents get keys only via `API_KEY` / boot-mint. | Most deployments — provision keys yourself. |
| `secret` | Caller must send `Authorization: Bearer <REGISTRATION_SECRET>`. Wrong/missing → `401`. | Trusted-group invite. |
| `open` | Anyone may register; bounded only by the per-IP rate limiter. | A relay intentionally hosted for the public. |

The per-IP rate limiter (`REGISTER_RATE_LIMIT` / `REGISTER_RATE_WINDOW_SECONDS`)
applies in both `secret` and `open` modes. With `REGISTRATION_MODE=secret`, the
relay **fails fast at startup** if `REGISTRATION_SECRET` is unset.

All credentials must live in the ACA **secret store** and be referenced with
`secretref:` — never as plain env vars. `redactConfig`
(`packages/relay/src/config.ts`) keeps them out of logs; preserve that.

## Encryption master key — `PANE_SECRET_KEY`

Pane encrypts secrets at rest (currently webhook callback secrets) with an
AES-256-GCM master key.

In **development**, if `PANE_SECRET_KEY` is unset the relay generates a key and
persists it to `.pane-secret-key` next to the process.

In **production this auto-generate is disabled.** ACA containers have an
**ephemeral filesystem** and restart freely — a generated key file would not
survive, so every restart or new replica would mint a *fresh* key and make all
previously-encrypted data permanently undecryptable. Startup therefore throws
if `PANE_SECRET_KEY` is unset.

### Generate a key

```bash
openssl rand -base64 32
```

Store the output as the ACA secret `pane-secret-key`. Keep it stable for the
life of the deployment.

### Rotation implications

There is currently **no key-rotation mechanism**. Changing `PANE_SECRET_KEY`
orphans everything encrypted under the old key — existing webhook secrets stop
decrypting (you'll see `webhook secret decrypt failed` in the logs). If you
must rotate, treat it as a clean break: rotate the key *and* re-register any
sessions/webhooks that carry encrypted secrets.

## `PUBLIC_URL` — the two-step deploy

Human-facing session URLs are built from `PUBLIC_URL` (`packages/relay/src/config.ts`).
If it's wrong, every URL handed to a human is unreachable. In production the
relay refuses to start if `PUBLIC_URL` is unset or still points at `localhost`.

The catch: **the ACA ingress FQDN does not exist until the Container App
exists.** So deployment is inherently two steps:

1. **Create the Container App** (step 4 below) — at this point `PUBLIC_URL` is
   not yet known. Set a placeholder, or expect the first revision to fail the
   preflight; that's fine, you'll fix it in step 2.
2. **Read the FQDN and wire it back in:**

   ```bash
   FQDN=$(az containerapp show \
     --name pane --resource-group <rg> \
     --query properties.configuration.ingress.fqdn -o tsv)

   az containerapp update \
     --name pane --resource-group <rg> \
     --set-env-vars PUBLIC_URL=https://$FQDN
   ```

   This triggers a new revision that passes the preflight.

Once you attach a custom domain, update `PUBLIC_URL` to that domain.

## Self-hosting with Docker + SQLite

The Azure steps below are the *reference* deployment. For a solo or small-team
self-host you do not need Azure, Postgres, or a container registry — the relay
runs as one container against a SQLite file.

### What you deploy

Only the **relay**, and you do **not** need to clone the repo to run it — a
prebuilt image is published to the GitHub Container Registry on every release:

```
ghcr.io/aerolalit/pane:<version>     # e.g. :0.1.0
ghcr.io/aerolalit/pane:latest
```

Pin a real version tag for reproducible deploys; `latest` moves. The image
bundles the human-facing web UI (the `/s/:token` shell page), so there is no
separate frontend to deploy. The `pane` CLI runs wherever your agent runs; it
is not part of the deployment.

### docker-compose (quickest)

The repo ships a [`docker-compose.yml`](../docker-compose.yml) that pulls the
GHCR image — copy just that file into an empty directory (no clone needed) and
create a `.env` next to it:

```bash
NODE_ENV=production
PUBLIC_URL=https://pane.example.com      # the public URL — see "PUBLIC_URL" below
PANE_SECRET_KEY=                         # openssl rand -base64 32
API_KEY=pane_xxxxxxxxxxxxxxxxxxxxxxxx    # optional; bootstraps your agent key
# REGISTRATION_MODE defaults to closed — leave unset unless you want self-service
```

Then:

```bash
docker compose up -d
```

Migrations run automatically on boot, a named volume (`pane-data`) persists the
SQLite database at `/app/data` across restarts, and `docker compose` runs a
`GET /healthz` healthcheck. Upgrade with `docker compose pull && docker compose up -d`.

### docker run (without compose)

```bash
docker run -d -p 3000:3000 \
  -e NODE_ENV=production \
  -e PUBLIC_URL=https://pane.example.com \
  -e PANE_SECRET_KEY="$(openssl rand -base64 32)" \
  -e API_KEY=pane_xxxxxxxxxxxxxxxxxxxxxxxx \
  -v pane-data:/app/data \
  ghcr.io/aerolalit/pane:latest
```

### Building from source (contributors)

If you are modifying pane or want an unreleased build, build the image from a
checkout instead of pulling it. The `docker-compose.yml` has a commented
`build:` block for this; or directly:

```bash
docker build -f packages/relay/Dockerfile -t pane .   # context = repo root
```

To run the relay straight from source without Docker:

```bash
npm install
npm run build  --workspace @pane/relay
npm run migrate:deploy --workspace @pane/relay
NODE_ENV=production PUBLIC_URL=... PANE_SECRET_KEY=... \
  npm run start --workspace @pane/relay
```

### Database

SQLite is the default and is the recommended store for a self-host — one file,
no separate service. The default Docker image (`docker build` with no
`--build-arg`) bakes the SQLite-targeted Prisma client and is byte-for-byte the
same as before. Postgres is the hosted/Azure path (see below): build the image
with `--build-arg DATABASE_PROVIDER=postgres` to bake the postgresql-targeted
client, then run it against a `postgresql://` `DATABASE_URL`. The container's
boot-time `migrate deploy` is engine-aware — it detects sqlite vs postgres from
`DATABASE_URL` and applies the matching migration set automatically. For a solo
deployment, stay on SQLite.

### TLS and reverse proxy

The relay speaks plain HTTP on `PORT`. For anything internet-facing, put a
reverse proxy (Caddy, nginx, Traefik) in front to terminate TLS. The proxy
**must forward WebSocket upgrades** for `/v1/sessions/:id/stream`, and
`PUBLIC_URL` must exactly match the public scheme + host the proxy serves —
the relay bakes it into every participant URL and the WebSocket CSP origin.

### Keys for a self-host

With `REGISTRATION_MODE` at its default (`closed`), no one can self-register.
Provide your agent's key via `API_KEY`, or let the relay mint one on first boot
and read it from the logs (`docker compose logs`). Open `secret`/`open`
registration only if you actually want other agents to provision themselves —
see "Registration mode" above.

### Solo quickstart

```bash
# 1. configure — in an empty directory, drop in docker-compose.yml and a .env
#    (no clone needed). Copy the env keys from packages/relay/.env.example.
#    Set NODE_ENV=production, PUBLIC_URL, PANE_SECRET_KEY (openssl rand -base64 32).

# 2. run — pulls ghcr.io/aerolalit/pane and starts it
docker compose up -d

# 3. point the CLI at it and do a round trip
PANE_URL=https://pane.example.com PANE_API_KEY=<your key> \
  pane create --artifact ./form.html --schema ./schema.json --ttl 600
```

## Deploy steps (Azure Container Apps)

Prerequisites: `az` CLI logged in, a resource group, providers registered
(`Microsoft.App`, `Microsoft.OperationalInsights`, `Microsoft.DBforPostgreSQL`).

### 1. PostgreSQL — Flexible Server

```bash
az postgres flexible-server create \
  --name <pg-server> --resource-group <rg> \
  --database-name pane --public-access 0.0.0.0
```

Capture the connection string for `DATABASE_URL`. Ensure ACA can reach the
server (firewall rule allowing Azure services, or a shared VNet).

### 2. Container Registry + build the image

```bash
az acr create --name <acr> --resource-group <rg> --sku Basic
az acr build --registry <acr> -t pane:v1 packages/relay
```

`az acr build` builds in-cloud — no local Docker needed.

### 3. Container Apps environment

```bash
az containerapp env create \
  --name <env> --resource-group <rg> --location <region>
```

### 4. Create the Container App

```bash
az containerapp create \
  --name pane --resource-group <rg> --environment <env> \
  --image <acr>.azurecr.io/pane:v1 \
  --registry-server <acr>.azurecr.io \
  --target-port 3000 --ingress external --transport auto \
  --min-replicas 1 --max-replicas 1 \
  --secrets database-url="<pg-conn>" \
            pane-secret-key="$(openssl rand -base64 32)" \
            api-key="pane_..." \
            registration-secret="<secret>" \
  --env-vars DATABASE_URL=secretref:database-url \
             PANE_SECRET_KEY=secretref:pane-secret-key \
             API_KEY=secretref:api-key \
             REGISTRATION_SECRET=secretref:registration-secret \
             PORT=3000 NODE_ENV=production LOG_LEVEL=info
```

- `--transport auto` is **required** so WebSocket upgrades work on
  `/v1/sessions/:id/stream`.
- `PUBLIC_URL` is intentionally omitted here — wired in step 6.

### 5. Health probes

Configure **liveness + readiness** HTTP probes against `GET /healthz` on port
`3000`. `/healthz` is excluded from request logging.

### 6. Wire `PUBLIC_URL`

Follow the two-step procedure under "`PUBLIC_URL`" above: read the FQDN, then
`az containerapp update --set-env-vars PUBLIC_URL=https://$FQDN`.

### 7. Migrations

Run the Postgres migrations against the Flexible Server before/with the first
rollout:

```bash
npm run migrate:postgres:deploy --workspace @pane/relay
```

(or run it as a one-off ACA job / init container — pick one and keep it
consistent).

## Verifying the deployment

```bash
curl https://<fqdn>/healthz          # -> 200
```

Then run a real round trip with the CLI (`pane create ...`) pointed at
`https://<fqdn>` and confirm the human URL it returns is reachable and not a
`localhost` URL.
