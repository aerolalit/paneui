# Runbook — a blob token has leaked

Scope: someone outside the intended audience has access to a
`/b/<token>` URL. This runbook walks the agent owner through the
revocation + audit + rotation steps.

## 0. Posture

The token is a bearer secret in URL form. Treat the situation as:
**any unauthorised holder can fetch the blob's bytes from now until
the token's TTL expires or you revoke it.** Speed matters; thoroughness
matters more.

## 1. Identify the token

You'll usually know the leaked URL — copy the token portion (everything
after `/b/`). If you only know the blob_id but not the token:

```sh
pane blob show <blob_id>
```

This prints every active token for the blob, with audit metadata. Look
for the token that matches the leaked URL's prefix (`token_prefix` is
the first 10 chars; the leaked URL contains the full token).

If your `last_seen_ip_net` doesn't match the IP range the token was
issued for (typical: `first_seen_ip_net` = the human's home /24,
`last_seen_ip_net` = a different ISP), the token has likely been used
from somewhere unexpected.

## 2. Revoke

```sh
pane blob revoke-token <blob_id> <token_id>
```

The revocation propagates to the in-process cache in < 1 second across
every relay replica (the DB row is the source of truth; the cache is a
fast-path). Subsequent GETs against `/b/<token>` return 401
`blob_token_invalid`.

If you're on a multi-replica deployment without shared revoke state
(unusual; pane defaults are single-replica or Redis-coordinated), each
replica picks up the revocation on its next DB miss within ~5 seconds.

Idempotent: calling revoke twice against the same token returns the
same shape and is harmless. Useful if you're not sure whether the
first call succeeded.

## 3. Verify the revocation landed

```sh
pane blob show <blob_id>
```

The token's `revoked_at` should now be set. The next GET against the
leaked URL should return 401:

```sh
curl -i https://relay.paneui.com/b/<leaked-token>
# HTTP/2 401
# {"error":{"code":"blob_token_invalid",...}}
```

If you don't see 401 within 5 seconds, escalate to the relay operator
— there's a propagation issue.

## 4. Assess blast radius

Look at the audit columns from step 1:

- **`use_count`** — how many times the token was used before revoke.
- **`first_seen_ip_net`** vs **`last_seen_ip_net`** — were the uses
  consistent with the intended human, or did they come from somewhere
  unexpected?
- **`last_used_at`** — when was the last successful GET? If it's
  recent (< 5 min ago), assume the leaked URL was just used.

Pane truncates IPs at storage time (`/24` IPv4, `/48` IPv6) — you won't
see exact addresses, only network ranges. This is by design (we don't
want to be a tracking database). The ranges are usually enough to
distinguish "home network vs. work network vs. random ISP."

## 5. Decide whether to rotate the blob

A revoked token blocks future fetches of the SAME blob_id by the SAME
URL. If the content of the blob is sensitive AND you suspect it was
downloaded before revocation:

```sh
# Get the bytes locally first (so you don't lose them).
pane blob download <blob_id> --out ./recovered.jpg

# Upload as a new blob (gets a new blob_id, new token).
pane blob upload --file ./recovered.jpg --scope <same-scope> --session-id <same-session>

# Update any event payloads / input_data that referenced the old blob_id
# to point at the new one. (For session-scope blobs that participants
# have already fetched, you might also want to close the session and
# create a fresh one — the participants may have cached the URL.)

# Delete the old blob.
pane blob delete <old_blob_id>
```

The old `/b/<token>` URL is now a dead end: token revoked AND the blob
itself is gone.

## 6. Document the leak

For your own future-proofing, log the incident somewhere durable
(your project's secrets-and-incidents log; not just memory):

- Time of leak detection
- Time of revocation
- Suspected leak vector (screenshot? forwarded email? copy-paste to
  Slack?)
- `use_count` and IP ranges at the time of revocation
- Whether you rotated the blob

The leak-vector field is the load-bearing one. If you see a pattern
(your team keeps screenshotting URLs into chat), tighten the workflow:
use `--once` tokens for sensitive content, never share long-lived
agent-scope tokens, etc.

## 7. Prevention going forward

For the use case that triggered this incident:

| If the leak vector was... | Tighten by... |
|---------------------------|---------------|
| Screenshot / screen share | Embed the blob in an artifact instead of sharing a raw URL. Artifacts in sessions are scoped to participant tokens that you can revoke independently. |
| Copy-paste into chat / email | Use `--once` tokens. Even if pasted somewhere unexpected, the first GET consumes them. |
| Long-lived agent-scope tokens | Default to session-scope. Mint agent-scope only when the asset really is reusable across sessions; rotate every 24h (the default) rather than extending the TTL. |
| Browser history / autocomplete | Don't put sensitive blobs in URLs that humans see directly. Use the authenticated `GET /v1/blobs/<id>` (agent-only) for anything that doesn't need a participant URL. |
| Proxy / LB logs | Audit your egress path. The relay redacts tokens at its own access log, but an upstream LB may not. Configure egress logging accordingly. |

## Related

- [`docs/CAPABILITY-URLS.md`](./CAPABILITY-URLS.md) — full threat model
- [`docs/SECURITY-POLYGLOTS.md`](./SECURITY-POLYGLOTS.md) — content-side defence
- [`docs/BLOB_BACKENDS.md`](./BLOB_BACKENDS.md) — backend compatibility
- Tracking: [pane#155](https://github.com/aerolalit/paneui/issues/155)
