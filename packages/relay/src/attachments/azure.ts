// AzureBlobStore — backend implementation against Azure Blob Storage.
//
// Auth model (in priority order):
//   1. `BLOB_STORE_AZURE_CONNECTION_STRING` if set — used only for local dev
//      and Azurite. The relay logs a warning at startup because connection
//      strings on disk are an anti-pattern for prod.
//   2. Managed identity via @azure/identity's DefaultAzureCredential. This is
//      the production path: the Container App is granted `Storage Blob Data
//      Contributor` on the container, the SDK negotiates the right token,
//      no secret material ever touches the relay's filesystem or env.
//
// Storage:
//   * Each attachment is stored at `<storageKey>` in the configured container.
//   * Content metadata: sha256 is round-tripped via the `x-ms-meta-sha256`
//     custom-metadata property (Azure exposes this as `metadata.sha256`).
//   * Size + ETag come from the HEAD response.
//
// Direct-to-storage uploads (presigned PUT) use SAS query parameters scoped
// to:
//   * single attachment (sr=b)
//   * create-only permission (sp=cw)
//   * short lifetime (config.BLOB_PRESIGN_TTL_SECONDS, default 10 min)
//
// TOCTOU defence: after the client posts /v1/attachments/<id>/confirm, the relay
// calls head() and verifies `size` + the sha256 metadata stamp match what
// was committed at presign time. A mismatch rejects the attachment and removes
// the bytes.

import { Readable } from "node:stream";
import {
  AccountSASPermissions,
  AccountSASResourceTypes,
  AccountSASServices,
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateAccountSASQueryParameters,
  generateBlobSASQueryParameters,
  type ContainerClient,
} from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import {
  AttachmentIntegrityError,
  AttachmentSizeExceededError,
  type AttachmentObjectInfo,
  type AttachmentStore,
  type WriteOpts,
} from "./store.js";

/** Subset of @azure/storage-blob's UserDelegationKey we actually need. */
interface UserDelegationKey {
  signedObjectId: string;
  signedTenantId: string;
  signedStartsOn: Date;
  signedExpiresOn: Date;
  signedService: string;
  signedVersion: string;
  value: string;
}

export interface AzureBlobStoreOpts {
  /** Container the relay reads/writes. Created at init() if missing. */
  container: string;
  /**
   * One of:
   *  - `{ kind: "connectionString", value: "..." }` (dev / Azurite)
   *  - `{ kind: "accountUrl", url: "https://<acct>.attachment.core.windows.net" }`
   *    (managed-identity path; `DefaultAzureCredential` does the rest)
   */
  auth:
    | { kind: "connectionString"; value: string }
    | { kind: "accountUrl"; url: string };
  /** Presigned PUT TTL in seconds. */
  presignTtlSeconds: number;
}

export class AzureBlobStore implements AttachmentStore {
  private readonly service: BlobServiceClient;
  private readonly container: ContainerClient;
  private readonly authKind: AzureBlobStoreOpts["auth"]["kind"];
  private readonly sharedKey?: StorageSharedKeyCredential;
  private readonly accountName: string;
  private readonly presignTtlSeconds: number;

  /**
   * Cached User Delegation Key (managed-identity SAS). Azure returns a new
   * key per delegation request; for performance we cache one for ~50 minutes
   * and refresh on demand.
   */
  private udk?: { key: UserDelegationKey; expiresAt: number };

  constructor(opts: AzureBlobStoreOpts) {
    this.presignTtlSeconds = opts.presignTtlSeconds;
    this.authKind = opts.auth.kind;

    if (opts.auth.kind === "connectionString") {
      this.service = BlobServiceClient.fromConnectionString(opts.auth.value);
      // Extract the account name + key from the connection string so we can
      // also sign SAS tokens directly (managed-identity flow uses the
      // service.getUserDelegationKey() path).
      const parsed = parseConnectionString(opts.auth.value);
      this.sharedKey = parsed.sharedKey;
      this.accountName = parsed.accountName;
    } else {
      const credential = new DefaultAzureCredential();
      this.service = new BlobServiceClient(opts.auth.url, credential);
      this.accountName = extractAccountName(opts.auth.url);
    }

    this.container = this.service.getContainerClient(opts.container);
  }

  /**
   * Verify the container exists; create it if missing (so a fresh self-host
   * "just works"). Idempotent.
   */
  async init(): Promise<void> {
    await this.container.createIfNotExists();
  }

  async put(
    key: string,
    body: Readable,
    opts: WriteOpts,
  ): Promise<AttachmentObjectInfo> {
    // Streaming upload with mid-stream byte counting + sha256 + cap. The
    // Azure SDK's `uploadStream` takes a Node Readable directly and chunks
    // it into block-attachment blocks under the hood; we tap the stream to count
    // + hash before it reaches the SDK.
    const { createHash } = await import("node:crypto");
    const hasher = createHash("sha256");
    let observed = 0;

    const { Transform } = await import("node:stream");
    let cutForSize = false;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (cutForSize) return cb();
        observed += chunk.length;
        if (observed > opts.maxBytes) {
          cutForSize = true;
          return cb(new AttachmentSizeExceededError(opts.maxBytes, observed));
        }
        hasher.update(chunk);
        cb(null, chunk);
      },
    });

    body.pipe(tap);

    const blockBlob = this.container.getBlockBlobClient(key);
    try {
      // 4 MB blocks * up to 5 concurrency = balanced throughput vs memory.
      await blockBlob.uploadStream(tap, 4 * 1024 * 1024, 5, {
        blobHTTPHeaders: { blobContentType: opts.mime },
      });
    } catch (e) {
      if (e instanceof AttachmentSizeExceededError) {
        // Don't leak a partial block-attachment — best-effort delete.
        await blockBlob.deleteIfExists().catch(() => {
          /* best-effort */
        });
        throw e;
      }
      // For any other backend error, also clean up.
      await blockBlob.deleteIfExists().catch(() => {
        /* best-effort */
      });
      throw e;
    }

    const sha256 = hasher.digest("hex");

    // Write sha256 as custom metadata so head() can return it without
    // re-downloading the attachment to recompute.
    await blockBlob.setMetadata({ sha256 });

    return { size: observed, sha256, mime: opts.mime };
  }

  async get(key: string): Promise<Readable | null> {
    const attachment = this.container.getBlockBlobClient(key);
    try {
      const dl = await attachment.download();
      if (!dl.readableStreamBody) return null;
      // Azure returns NodeJS.ReadableStream in Node; type matches `Readable`
      // for piping purposes. Safe cast.
      return dl.readableStreamBody as Readable;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async head(key: string): Promise<AttachmentObjectInfo | null> {
    const attachment = this.container.getBlockBlobClient(key);
    try {
      const props = await attachment.getProperties();
      const size = props.contentLength ?? 0;
      const sha256 = props.metadata?.sha256;
      if (!sha256) {
        // Blob exists but has no sha256 metadata. Either the upload didn't
        // complete the setMetadata step, or someone wrote a attachment outside
        // the relay. Treat as integrity failure (caller's TOCTOU check
        // will refuse the attachment).
        return null;
      }
      return {
        size,
        sha256,
        mime: props.contentType,
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const attachment = this.container.getBlockBlobClient(key);
    await attachment.deleteIfExists();
  }

  // -------------------------------------------------------------------------
  // Presigned PUT support (presign + verify). Not on the AttachmentStore interface
  // yet (only Azure ships this in this PR); callers reach for it via a
  // capability check.
  // -------------------------------------------------------------------------

  /**
   * Issue a SAS query string the client can append to a PUT URL to upload
   * directly to Azure Blob. Scoped to: this exact key, create+write only,
   * `presignTtlSeconds`. Returns the absolute URL with the SAS attached.
   */
  async presignPut(opts: {
    key: string;
    mime: string;
    sha256: string;
  }): Promise<{ uploadUrl: string; expiresAt: Date }> {
    const expiresOn = new Date(Date.now() + this.presignTtlSeconds * 1000);
    const attachment = this.container.getBlockBlobClient(opts.key);

    let sas: string;
    if (this.sharedKey) {
      // Connection-string path (dev / Azurite).
      sas = generateBlobSASQueryParameters(
        {
          containerName: this.container.containerName,
          blobName: opts.key,
          permissions: BlobSASPermissions.parse("cw"),
          startsOn: new Date(Date.now() - 60_000),
          expiresOn,
          contentType: opts.mime,
        },
        this.sharedKey,
      ).toString();
    } else {
      // Managed-identity path — use a User Delegation Key.
      const udk = await this.getUserDelegationKey();
      sas = generateBlobSASQueryParameters(
        {
          containerName: this.container.containerName,
          blobName: opts.key,
          permissions: BlobSASPermissions.parse("cw"),
          startsOn: new Date(Date.now() - 60_000),
          expiresOn,
          contentType: opts.mime,
        },
        udk,
        this.accountName,
      ).toString();
    }

    return {
      uploadUrl: `${attachment.url}?${sas}`,
      expiresAt: expiresOn,
    };
  }

  /**
   * After the client confirms a presigned PUT, verify the bytes actually
   * landed and match the committed size + sha256 expectation. Returns the
   * verified info on success; throws `AttachmentIntegrityError` on mismatch.
   *
   * The caller (route layer) is responsible for stamping the sha256 we
   * computed at presign time into the attachment's metadata BEFORE this verifies
   * — except the client never had access to write metadata via SAS (sp=cw
   * doesn't include `m` write-metadata permission), so the relay does it
   * here as part of the confirm flow.
   */
  async confirmPresigned(
    key: string,
    expected: { size: number; sha256: string; mime: string },
  ): Promise<AttachmentObjectInfo> {
    const attachment = this.container.getBlockBlobClient(key);
    const props = await attachment.getProperties().catch((e) => {
      if (isNotFound(e)) return null;
      throw e;
    });
    if (!props) {
      throw new AttachmentIntegrityError(
        { size: expected.size, sha256: expected.sha256 },
        { size: 0, sha256: "<missing>" },
      );
    }
    const observedSize = props.contentLength ?? 0;
    if (observedSize !== expected.size) {
      // Bytes don't match what was committed. Delete + raise.
      await attachment.deleteIfExists().catch(() => {
        /* best-effort */
      });
      throw new AttachmentIntegrityError(
        { size: expected.size, sha256: expected.sha256 },
        { size: observedSize, sha256: "<not-yet-known>" },
      );
    }

    // Compute the actual sha256 by streaming the attachment back. Slightly
    // expensive (one extra GET) but the cost of being wrong here is the
    // entire security story falling over — the TOCTOU defence MUST verify
    // bytes, not trust client claims.
    const dl = await attachment.download();
    if (!dl.readableStreamBody) {
      throw new AttachmentIntegrityError(
        { size: expected.size, sha256: expected.sha256 },
        { size: observedSize, sha256: "<unreadable>" },
      );
    }
    const { createHash } = await import("node:crypto");
    const hasher = createHash("sha256");
    for await (const chunk of dl.readableStreamBody as Readable) {
      hasher.update(chunk as Buffer);
    }
    const actualSha = hasher.digest("hex");
    if (actualSha !== expected.sha256) {
      await attachment.deleteIfExists().catch(() => {
        /* best-effort */
      });
      throw new AttachmentIntegrityError(
        { size: expected.size, sha256: expected.sha256 },
        { size: observedSize, sha256: actualSha },
      );
    }

    // Stamp the verified sha256 + content-type as attachment metadata so future
    // head() calls can return them without recomputing.
    await attachment.setMetadata({ sha256: actualSha });
    await attachment.setHTTPHeaders({ blobContentType: expected.mime });

    return { size: observedSize, sha256: actualSha, mime: expected.mime };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Fetch a User Delegation Key for SAS minting under managed-identity auth.
   * Cached for ~50 minutes (Azure max is 7 days, but a short window limits
   * the blast radius if a UDK is somehow exfiltrated).
   */
  private async getUserDelegationKey(): Promise<UserDelegationKey> {
    if (this.udk && this.udk.expiresAt > Date.now() + 5 * 60 * 1000) {
      return this.udk.key;
    }
    const startsOn = new Date(Date.now() - 60_000);
    const expiresOn = new Date(Date.now() + 60 * 60 * 1000);
    const key = (await this.service.getUserDelegationKey(
      startsOn,
      expiresOn,
    )) as UserDelegationKey;
    this.udk = { key, expiresAt: expiresOn.getTime() };
    return key;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConnectionStringParts {
  accountName: string;
  sharedKey: StorageSharedKeyCredential;
}

function parseConnectionString(cs: string): ConnectionStringParts {
  // Azure connection strings are `key1=value1;key2=value2;...`.
  const parts = new Map<string, string>();
  for (const segment of cs.split(";")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    parts.set(segment.slice(0, eq), segment.slice(eq + 1));
  }
  const accountName = parts.get("AccountName") ?? "devstoreaccount1";
  const accountKey = parts.get("AccountKey");
  if (!accountKey) {
    throw new Error(
      "BLOB_STORE_AZURE_CONNECTION_STRING is missing AccountKey — cannot mint SAS",
    );
  }
  return {
    accountName,
    sharedKey: new StorageSharedKeyCredential(accountName, accountKey),
  };
}

function extractAccountName(accountUrl: string): string {
  // `https://<account>.attachment.core.windows.net[/...]` — the host's first label.
  const u = new URL(accountUrl);
  return u.hostname.split(".")[0] ?? "";
}

function isNotFound(e: unknown): boolean {
  const status =
    (e as { statusCode?: number; status?: number })?.statusCode ??
    (e as { status?: number })?.status;
  return status === 404;
}

// Suppress unused-import warnings for the AccountSAS imports that some
// future expansion may use (e.g. for one-shot container-scoped tokens).
// Removing them now and re-adding later is more churn than the lint cost.
void AccountSASPermissions;
void AccountSASResourceTypes;
void AccountSASServices;
void generateAccountSASQueryParameters;
