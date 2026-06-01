# Blob storage backends

Tracking issue: [#154](https://github.com/aerolalit/paneui/issues/154) — verifies the backend compatibility claims below.

Pane v0.1.0 ships two `BlobStore` implementations:

- **`filesystem`** — self-host default. Single-VM only. Zero-config.
- **`azure`** — Azure Blob Storage. Hosted Pane's backend of record.

Other clouds (AWS S3, Cloudflare R2, GCS) are out of scope for v0.1.0
but the interface is the seam that lets them land later behind the same
route code.

## Selecting a backend

Set `BLOB_STORE` in the relay env:

```
BLOB_STORE=filesystem  # default; the in-process FilesystemBlobStore
BLOB_STORE=azure       # the AzureBlobStore — requires Azure config below
```

`BLOB_STORE=filesystem` never imports `@azure/storage-blob`. The factory
dynamic-imports the Azure backend only when the env var selects it, so a
self-host bundle stays slim.

## Filesystem backend (self-host)

Single-VM only. Files live under `BLOB_STORE_FS_DIR` (default
`./data/blobs`; the published Docker image pins this to `/app/data/blobs`
so blobs land in the persisted data volume alongside the SQLite DB) with
mode `0600`. Atomic commit via `<key>.tmp` → `<key>` rename, so a crash
mid-write can't leak a partial blob.

The relay refuses to start when:
- `BLOB_STORE_FS_DIR` exists with world-readable permissions
  (`mode & 0o007 !== 0`). Run `chmod o-rwx <dir>` and restart.
- The directory exists but is a regular file.

Caveats:
- **Does NOT work behind a multi-replica autoscaler.** Different replicas
  see different filesystems unless you mount a shared NFS-style FS — and
  the relay does not coordinate writes across replicas.
- Use **Azure Blob** for any deployment that runs ≥2 replicas.
- The data directory must be on a filesystem that honours `fsync` for
  durability. Some network filesystems silently no-op fsync; we don't
  detect this — it's on the operator to choose appropriate storage.

## Azure Blob backend (hosted)

The relay uses Microsoft's official `@azure/storage-blob` SDK with
authentication via `DefaultAzureCredential`:

1. **Managed identity** (production) — the Azure Container App is granted
   `Storage Blob Data Contributor` on the container. No secrets on disk.
2. **Connection string** (dev / Azurite only) — set
   `BLOB_STORE_AZURE_CONNECTION_STRING`. The relay logs a startup warning
   so this never ships to prod by accident.

Required environment:

```
BLOB_STORE=azure
BLOB_STORE_AZURE_CONTAINER=pane-blobs                       # created if missing
BLOB_STORE_AZURE_ACCOUNT_URL=https://<account>.blob.core.windows.net
# OR (dev/Azurite only):
BLOB_STORE_AZURE_CONNECTION_STRING=DefaultEndpointsProtocol=...
```

### Presigned uploads (SAS)

The hosted backend supports direct-to-storage uploads via SAS query
parameters. Flow:

1. Client → `POST /v1/blobs/presign` with `{mime, size, sha256, scope, …}`.
   Relay reserves a blob row (status=pending), mints a SAS scoped to that
   blob name (`sp=cw`, `sr=b`, `se=<+10min>`), returns `{blob_id,
   upload_url, expires_at}`.
2. Client PUTs the bytes to `upload_url` directly. The relay's CPU +
   bandwidth stay flat.
3. Client → `POST /v1/blobs/<id>/confirm`. Relay HEADs the bytes, streams
   them back to recompute sha256, verifies size + sha256 match the
   committed values (TOCTOU defence — see #154), flips status to ready.

The filesystem backend returns 501 `not_implemented` for `presign`; use
the multipart `POST /v1/blobs` fallback there.

## Azure RBAC + container policy

Recommended IAM:

```bicep
// Storage account: deny anonymous read at the data-plane.
resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  // ...
  properties: {
    allowBlobPublicAccess: false       // <- critical
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'     // or 'Disabled' with PE
  }
}

// Container: created on first run by the relay.
resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: '${sa.name}/default/${containerName}'
  // No anonymous access; only authenticated managed-identity reads.
}

// Role assignment: relay's identity → Storage Blob Data Contributor on
// JUST the container (not the whole storage account).
resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: container
  name: guid(container.id, relayManagedIdentity.id, 'blob-data-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe'   // Storage Blob Data Contributor
    )
    principalId: relayManagedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
```

For the hosted Pane deployment, this is wired in `paneui-ops/azure/`.

## Compatibility matrix

| Backend | Tested version | Round trip | Presigned PUT + TOCTOU | Conformance suite | Notes |
|---------|---------------|------------|------------------------|-------------------|-------|
| `filesystem` | relay v0.1.0 | ✅ | n/a (501) | every PR ([ci.yml](../.github/workflows/ci.yml) → `e2e-sqlite`) — 5/9 cases (presign cases n/a) | single-VM only |
| `azure` (Azurite emulator) | `mcr.microsoft.com/azure-storage/azurite:3.31.0` | ✅ | ✅ | every PR ([ci.yml](../.github/workflows/ci.yml) → `e2e-postgres` with `AZURITE_URL`) — 9/9 cases + meta-test | CI workhorse |
| `azure` (real Azure Blob) | latest @azure/storage-blob | ✅ | ✅ | weekly cron + on-demand ([blob-conformance-real-azure.yml](../.github/workflows/blob-conformance-real-azure.yml)) — 9/9 cases + meta-test | hosted-relay config of record |

Adding a new backend? See [#154](https://github.com/aerolalit/paneui/issues/154)
for the conformance suite every implementation must pass before this matrix
gets a new row.

## Conformance suite

The shared backend-conformance battery lives at
[`packages/relay/src/blobs/backend-conformance.ts`](../packages/relay/src/blobs/backend-conformance.ts).
One battery, parametrised over a `BlobStore` implementation. Adding a new
backend (S3, R2, GCS, …) means writing the implementation + a thin caller
test file that invokes `runConformanceSuite()` with the right capabilities —
no new test cases to write.

### Cases (9 + 1 meta)

| # | Case | FS | Azure |
|---|------|----|-------|
| 1 | Round-trip integrity (`put → get → byte-for-byte`) | ✅ | ✅ |
| 2 | Presigned PUT enforces declared size | n/a | ✅ |
| 3 | Presigned PUT enforces declared sha256 (TOCTOU defence) | n/a | ✅ |
| 4 | Re-PUT after confirm + re-confirm detects tampering | n/a | ✅ |
| 5 | `head()` returns committed size + sha256 after `put()` | ✅ | ✅ |
| 6 | `get()`/`head()` return null for unknown keys | ✅ | ✅ |
| 7 | Delete is durable (re-put returns new content, not stale) | ✅ | ✅ |
| 8 | Concurrent `put()` to same key leaves a consistent state | ✅ | ✅ |
| 9 | SAS scope rejects cross-key writes (forgery) | n/a | ✅ |
| meta | Case #3 has teeth (negative-control: TOCTOU-broken confirm passes a violation through) | n/a | ✅ |

The meta-test is the load-bearing acceptance criterion from #154: it runs
case #3's TOCTOU scenario against a deliberately-broken `confirmPresigned`
that performs zero verification, and asserts the broken implementation
accepts a sha256 mismatch. If case #3's pass/fail signal ever stopped
catching the regression, the meta-test would flip and pane it.

### Per-backend test files

- [`packages/relay/src/blobs/filesystem.conformance.test.ts`](../packages/relay/src/blobs/filesystem.conformance.test.ts)
- [`packages/relay/src/blobs/azure.conformance.e2e.test.ts`](../packages/relay/src/blobs/azure.conformance.e2e.test.ts)

Filesystem doesn't implement `presignPut` on main; cases #2/#3/#4/#9 are
gated by `caps.presign = false` and show up in the report as skipped (not
silently absent) — the matrix above mirrors that exactly.

## SDK install gating

`@azure/storage-blob` and `@azure/identity` live in `optionalDependencies`
of `@paneui/relay`. A self-host install with `BLOB_STORE=filesystem` can
skip optionals (`npm install --omit=optional`) and the relay still boots
cleanly — the factory's filesystem branch never imports the Azure module.

If `BLOB_STORE=azure` is set but the SDK packages are missing, the relay
fails fast at boot with a single actionable error pointing the operator
at `npm install @azure/storage-blob @azure/identity`. The factory uses
the same dynamic-import + clean-error pattern that
[`src/redis.ts`](../packages/relay/src/redis.ts)'s `loadIoredis()` uses
for the optional `ioredis` dependency.

Verified by
[`packages/relay/src/blobs/factory.test.ts`](../packages/relay/src/blobs/factory.test.ts)
— it mocks `@azure/storage-blob` and `@azure/identity` to throw on import,
then calls `makeBlobStore({ BLOB_STORE: "filesystem", … })` and asserts
the call succeeds (proving the filesystem branch never touches the Azure
modules).

## Related

- [`docs/SECURITY-POLYGLOTS.md`](./SECURITY-POLYGLOTS.md) — polyglot defence
- [`docs/CAPABILITY-URLS.md`](./CAPABILITY-URLS.md) — `/b/<token>` threat model
- [`docs/RUNBOOK-LEAKED-TOKEN.md`](./RUNBOOK-LEAKED-TOKEN.md) — incident response
- Proposal: [pane#152](https://github.com/aerolalit/paneui/issues/152)
