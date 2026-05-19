# Deploying Pane

Pane runs as a container relay. This guide covers the hosted reference
deployment on **Azure Container Apps (ACA)** backed by Azure Database for
PostgreSQL. Deploying elsewhere (any container host) follows the same shape —
the env-var contract is the only thing that matters.

> **Replicas.** A single replica needs no external services. To scale past one
> replica, set `REDIS_URL` so cross-replica event fan-out, rate limiting, and
> presence stay consistent — see [Running multiple replicas](#running-multiple-replicas).
> Without `REDIS_URL`, pin `minReplicas = maxReplicas = 1`.

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

## Single-box self-host

For a solo or small-team relay — one container against a SQLite file, no
Postgres, no registry, no clone — see **[SELF-HOSTING.md](SELF-HOSTING.md)**.
The rest of this guide is the operator path: a Postgres-backed, optionally
multi-replica deployment with observability, using the Azure Container Apps
reference setup.

## Database

The hosted/operator path runs on **PostgreSQL**. A `-postgres` image variant is
published to GHCR on every release alongside the SQLite default:

```
ghcr.io/aerolalit/pane:<version>            # SQLite — the single-box self-host default
ghcr.io/aerolalit/pane:<version>-postgres   # Postgres — the hosted/operator build
ghcr.io/aerolalit/pane:latest-postgres
```

The two differ only in the Prisma client baked at build time (the datasource
provider is fixed at `prisma generate` time, so it cannot be switched at
runtime). Run the `-postgres` variant against a `postgresql://` `DATABASE_URL`.
The container's boot-time `migrate deploy` is engine-aware: it detects sqlite vs
postgres from `DATABASE_URL` and applies the matching migration set
automatically.

To build the Postgres variant locally: `docker build --build-arg
DATABASE_PROVIDER=postgres` (no `--build-arg` gives the SQLite image).

## Running multiple replicas

By default the relay runs as a **single process** and keeps three pieces of
state in memory: the event pub/sub bus, the rate limiter, and the WebSocket
presence registry. That is correct and fast for a single replica.

To run the relay as **multiple replicas** (e.g. an autoscaling container app),
set `REDIS_URL` to a Redis instance shared by every replica:

```bash
REDIS_URL=redis://my-redis:6379 npm start
```

With `REDIS_URL` set, the relay backs all three pieces of state with Redis so
every replica stays consistent:

- **Event pub/sub** — events publish to a Redis channel, so a subscriber on
  any replica receives an event published on any other.
- **Rate limiter** — the sliding window lives in Redis, so the configured
  limit is global across replicas rather than per-replica.
- **Presence** — the WebSocket presence registry lives in Redis, so counts
  reflect connections on every replica, not just the local one.

`REDIS_URL` is **optional**. The Redis client (`ioredis`) is an
`optionalDependency`, installed and loaded only when `REDIS_URL` is set. A relay
started with `REDIS_URL` but without `ioredis` installed fails fast with a clear
message, and a relay started with `REDIS_URL` unreachable fails fast on boot
rather than running with no shared state.

> When running multiple replicas behind a load balancer, enable session
> affinity (sticky sessions) so a WebSocket stays pinned to the replica that
> accepted its upgrade. The shared Redis state above makes *cross-replica
> visibility* correct; affinity keeps an individual long-lived socket on one
> replica for its lifetime.

## Observability

The relay is instrumented with the vendor-neutral
[OpenTelemetry](https://opentelemetry.io/) SDK. `METRICS_EXPORTER` selects where
telemetry goes; there are three modes:

**`none` (default)** — no telemetry is exported. The instrument helpers are
cheap no-ops, no exporter is constructed, no tracer provider is created, and
`GET /metrics` is not mounted (it returns 404). Operators opt in to one of the
modes below.

**`prometheus`** — `GET /metrics` serves the current metrics in the Prometheus
text exposition format on the relay's normal port; point a Prometheus scrape at
it. Exposed instruments include `pane_sessions_created_total`,
`pane_events_written_total`, `pane_registrations_total`, `pane_errors_total`,
`pane_ws_connections_active`, `pane_sessions_open`, and
`pane_http_request_duration_seconds`. `/metrics` is unauthenticated, which is
the norm for a Prometheus scrape target — if the relay is publicly reachable,
**firewall the endpoint** (or restrict it at a reverse proxy) so only your
monitoring stack can reach it. Prometheus has no trace ingestion, so no spans
are produced in this mode.

**`azure`** — pushes metrics, distributed traces (HTTP request spans plus DB
dependency spans), handled exceptions and application logs to [Azure
Application Insights](https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview).
This mode requires the **optional** `@azure/monitor-opentelemetry-exporter`
package (`npm install @azure/monitor-opentelemetry-exporter` — it is *not* a
hard dependency of the open-source core) and the
`APPLICATIONINSIGHTS_CONNECTION_STRING` environment variable. The relay fails
fast at startup with a clear error if the connection string is missing or the
package is not installed. `GET /metrics` is not mounted in `azure` mode.

## SSRF protection

Agent-supplied URLs — webhook callback URLs and `html-ref` artifact URLs — are
validated before use. They must be `http`/`https`, must not embed credentials,
and must not resolve to a loopback, private, link-local, or CGNAT address (this
also blocks the cloud metadata endpoint `169.254.169.254`). A URL that fails
these checks is rejected at the API boundary.

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
