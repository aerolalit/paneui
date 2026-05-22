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

| Backend | Tested version | Round trip | Presigned PUT + TOCTOU | Notes |
|---------|---------------|------------|------------------------|-------|
| `filesystem` | relay v0.1.0 | ✅ | n/a (501) | single-VM only |
| `azure` (Azurite emulator) | `mcr.microsoft.com/azure-storage/azurite:3.31.0` | ✅ | ✅ | CI workhorse |
| `azure` (real Azure Blob) | tested 2026-05-21 | ✅ | ✅ | hosted-relay config of record |

Adding a new backend? See [#154](https://github.com/aerolalit/paneui/issues/154)
for the conformance suite every implementation must pass before this matrix
gets a new row.

## Related

- [`docs/SECURITY-POLYGLOTS.md`](./SECURITY-POLYGLOTS.md) — polyglot defence
- [`docs/CAPABILITY-URLS.md`](./CAPABILITY-URLS.md) — `/b/<token>` threat model
- [`docs/RUNBOOK-LEAKED-TOKEN.md`](./RUNBOOK-LEAKED-TOKEN.md) — incident response
- Proposal: [pane#152](https://github.com/aerolalit/paneui/issues/152)
