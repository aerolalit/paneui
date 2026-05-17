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
| `REGISTRATION_SECRET` | recommended | Guards the open `POST /v1/register`. |
| `PORT` | no | Defaults to `3000`. |

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
