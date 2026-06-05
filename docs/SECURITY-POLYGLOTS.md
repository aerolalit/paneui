# Polyglot defense (blob attachments)

Tracking issue: [#153](https://github.com/aerolalit/paneui/issues/153) — verifies #152's polyglot strip claim.

## What we defend against

A **polyglot** file is one that's simultaneously valid in two formats. The
attacker classic: a file that decodes as a JPEG when fetched as
`Content-Type: image/jpeg`, but ALSO renders as HTML/JS if the browser
sniffs the content or a downstream proxy strips the type header. Common
shapes:

- **HTML / JPEG** — HTML appended after the JPEG EOI marker (`FF D9`).
- **GIF / JAR** ("GIFAR") — historical browser-plugin attack.
- **PNG with iTXt scripts** — text chunks containing executable payload.
- **SVG with inline `<script>`** — special case (see below).
- **PDF with embedded JavaScript** — handled at the disposition layer
  rather than via re-encode (PDFs are passthrough).
- **EXE / image** — Mach-O / ELF / PE bytes appended after image data.

The relay's MIME sniffer (`packages/relay/src/blobs/mime-sniff.ts`) catches
the trivial case where the client lies about `Content-Type`. Polyglots
are subtler: the leading bytes ARE a valid image. Sniffing alone isn't
enough.

## How the strip works

For every upload that sniffs to `image/{jpeg,png,gif,webp}`, the relay
runs the bytes through **libvips / sharp**:

1. Decode the image to raw pixel data.
2. Re-encode to the same format.

The decode-encode round trip carries **only the pixel data** forward. The
"second format" sitting outside the image stream — appended HTML, embedded
JAR bytes, malicious iTXt chunks — never makes it into the output.

The same step strips **EXIF / IPTC / XMP / ICC metadata + the embedded
JPEG thumbnail**. The thumbnail is a real footgun: you strip the main
image's EXIF but the JPEG-thumb-of-the-2000x2000-photo inside the file
keeps its own GPS coordinates. Sharp drops both.

Implementation: `packages/relay/src/blobs/normalize.ts`. Pinned dependency:

```json
"sharp": "~0.34.5"
```

The tilde pin is deliberate: Dependabot opens a patch-bump PR within 24h
of any sharp `0.34.x` release, the polyglot corpus + the rest of CI gate
the auto-merge ([`.github/workflows/dependabot-auto-merge.yml`](../.github/workflows/dependabot-auto-merge.yml)),
and minor / major bumps require manual review + a fresh corpus run.

## Pass-through MIMEs and their risks

| MIME | Posture | Why |
|------|---------|-----|
| `image/jpeg`, `image/png`, `image/gif`, `image/webp` | Normalised | sharp re-encodes; polyglot tails dropped |
| `image/svg+xml` | **Rejected by default; rasterised to PNG if opted in** | SVG carries `<script>` + event handlers as a feature and is not in the default allowlist. If an operator re-enables it (F-13), an accepted SVG is **rasterised to PNG** by the normaliser (`sharp(svgBytes).png()`, via libvips → librsvg) — the vector→bitmap decode drops every script / `on*` handler / `<foreignObject>` / `javascript:`/external ref. The stored attachment's MIME becomes `image/png`, so it joins the normalised raster set and serves `inline` like any other safe raster. The original SVG bytes are never stored or served. |
| `application/pdf` | Pass-through | Served `Content-Disposition: attachment` (only raster images render inline); the response also carries `Content-Security-Policy: default-src 'none'; sandbox`. |
| Anything else | Rejected by allowlist | Default `BLOB_MIME_ALLOWLIST=image/jpeg,image/png,image/gif,image/webp,application/pdf` |

### Default allowlist

The shipped default is an **explicit list of full MIME types**, deliberately
NOT the bare `image/` prefix (which would also admit `image/svg+xml`):

```
BLOB_MIME_ALLOWLIST=image/jpeg,image/png,image/gif,image/webp,application/pdf
```

An empty or unset `BLOB_MIME_ALLOWLIST=` **falls back to this default** — it
does NOT disable the allowlist (an accidental empty value must never fail open
and accept every type). To intentionally accept any sniffed MIME (only sensible
for a closed self-host), set the single sentinel value `BLOB_MIME_ALLOWLIST=*`.

### Operator note: SVG

Re-enabling SVG (`image/svg+xml`) is safe with respect to stored XSS: an
accepted SVG is **rasterised to PNG** (F-13) before it is stored, so no SVG
markup — `<script>`, `on*` handlers, `<foreignObject>`, `javascript:`/external
references — is ever persisted or served. The trade-off is that SVG semantics
are lost: the upload is flattened to a bitmap at the canvas size librsvg
derives from the SVG's `width`/`height`/`viewBox`, vector scalability is gone,
and a malformed SVG that librsvg can't parse is rejected as `mime_disallowed`
(415), the same path a corrupt raster takes. If an operator needs SVG stored
verbatim (vector-preserving), that is explicitly **not** supported — there is
no pass-through path for SVG.

## Defence-in-depth

The normalisation pass is the **primary** defence. Layered on top:

- **`X-Content-Type-Options: nosniff`** on every blob response — tells the
  browser to obey the declared `Content-Type` and not try to "intelligently"
  re-classify bytes as HTML.
- **`Content-Disposition: attachment`** for non-image MIMEs — forces
  download instead of inline render.
- **`Cross-Origin-Resource-Policy: same-origin`** — denies speculative
  cross-origin fetches.
- **Server-side MIME sniff** vs declared — the route REJECTS uploads
  where the declared `Content-Type` disagrees with the sniffed bytes
  (returns 415 `mime_mismatch`).

### Coverage: both upload routes

The same defence applies on every upload entry point. The pipeline is
factored into a single helper (`processBlobUpload` in
`packages/relay/src/blobs/upload-pipeline.ts`) and reused by:

- **`POST /v1/blobs`** — the agent-side multipart upload (agent API key).
- **`POST /s/:participantToken/blobs`** — the human-side multipart upload
  used by `window.pane.uploadBlob()` from inside a rendered pane
  (follow-up C of #156).

Because both routes share one pipeline, a polyglot uploaded by a human
through the participant route gets the same sharp re-encode + EXIF strip
as one uploaded by the agent. The participant route additionally pins
`scope=session`, so any blob landed through it is bounded by the
session's lifetime.

### Coverage: both download routes

The decrypt pipeline (envelope `parseEnvelope` + `decryptBlob` from
`packages/relay/src/blobs/encrypt.ts`) runs on every read path that
returns blob bytes:

- **`GET /v1/blobs/:id`** — the agent-side download (agent API key).
- **`GET /s/:participantToken/blobs/:blob_id`** — the iframe-side lazy
  fetch used by `window.pane.downloadBlob()` (follow-up D of #156).
- **`GET /b/<token>`** — the participant-facing capability URL.

When `BLOB_ENCRYPT_AT_REST=false` (the hosted default) the decrypt
branch is a no-op and the stream passes through unmodified. When it's
on, all three routes decrypt with the same master key + envelope via
the shared `encrypt.parseEnvelope` + `decryptBlob` calls, so they
cannot drift on encryption-at-rest semantics.

## The polyglot corpus

The claim "sharp's decode-encode drops appended polyglot payloads" is
verified by a tracked corpus at
[`packages/relay/test-fixtures/polyglots/`](../packages/relay/test-fixtures/polyglots/).

25 hand-authored fixtures cover five threat classes:

| Threat class | Count | What it tests |
|--------------|-------|---------------|
| `appended-payload` | 12 | HTML / EXE / ZIP appended after JPEG EOI, PNG IEND, GIF terminator, WebP RIFF |
| `in-format-chunk` | 5 | JPEG COM segment, PNG iTXt / zTXt / tEXt with script payloads, and a scripted SVG (`<script>` + `onload` + `javascript:` + `<foreignObject>`) — the SVG is rasterised to PNG, dropping all markup (F-13) |
| `metadata` | 1 | EXIF IFD0 with script-shaped Artist / ImageDescription |
| `passthrough-untouched` | 2 | PDF `/JS` action, HEIC + HTML trailer — documents what we *don't* normalise |
| `baseline` | 4 | known-good JPEG / PNG / GIF / WebP — verifies the normaliser preserves legitimate content |

Every fixture has a builder (`packages/relay/test-fixtures/polyglots/builders.ts`)
+ a sidecar (`meta/<name>.meta.json`) declaring its `mime`,
`threatClass`, expected normalisation outcome, and concrete assertions
(`outputDoesNotContain`, `bytesUnchanged`, etc.). The corpus loader
([`index.ts`](../packages/relay/test-fixtures/polyglots/index.ts))
enforces that builders and sidecars stay in sync — a missing pair
fails the suite at load time.

The corpus has a **negative-control meta-test**: a deliberately broken
"normaliser" that just passes the bytes through must FAIL the
assertions on at least one fixture. If `normalize.ts` ever regresses
to a pass-through, the corpus catches it.

### Adding a fixture

1. Drop a builder function in [`builders.ts`](../packages/relay/test-fixtures/polyglots/builders.ts).
2. Register it under a name in the `builders` map at the bottom.
3. Drop a matching `meta/<name>.meta.json` sidecar declaring the
   expected behaviour.
4. Run `npm test -- normalize.test.ts` from `packages/relay/`.

Full reference: [`packages/relay/test-fixtures/polyglots/README.md`](../packages/relay/test-fixtures/polyglots/README.md).

## If you find a bypass

If you can construct a file that:
1. Passes our MIME sniffer
2. Survives sharp's normalisation with malicious payload intact

…please **don't** open a public issue. Email the maintainer directly
(see `SECURITY.md` for the disclosure address) with a sample file. The
corpus at `packages/relay/test-fixtures/polyglots/` is meant to grow
forever — every bypass that ever worked stays in the suite, even after
the underlying library is patched.

## Versioning

- **sharp pinned** to `~0.34.5` in `packages/relay/package.json`.
- Dependabot ([`/.github/dependabot.yml`](../.github/dependabot.yml))
  opens patch-version bumps within 24h of upstream release.
- The auto-merge workflow
  ([`/.github/workflows/dependabot-auto-merge.yml`](../.github/workflows/dependabot-auto-merge.yml))
  flips on `gh pr merge --auto` for sharp patch bumps once every CI
  check — including the polyglot suite — is green. No other dependency
  is auto-merged.
- Minor bumps (`0.34.x → 0.35.x`) require manual review + a corpus rerun
  before merge — never auto-merged.
- Major bumps are blocked at the Dependabot config layer: the
  `version-update:semver-major` ignore rule prevents the PR from
  opening at all. Trigger one manually when the encoder semantics have
  been reviewed and the corpus has run against the new major.

## Blob-reference access check (events + session input_data)

Phase D of #156 registered a JSON-Schema vocabulary — `format: pane-blob-id`
— that event and input schemas use to mark a string field as a blob
reference (`{ "type": "string", "format": "pane-blob-id" }`). Ajv's
format validator is purely **syntactic**: it accepts cuid-shaped strings.

That alone is not enough. Without a DB lookup, an attacker could enumerate
blob ids inside event payloads and land on another agent's blob, or
re-attach a soft-deleted blob by baking its id into a page-emitted event.

Follow-up B of #156 closes that gap with a **route-layer DB check** that
runs *after* Ajv validates the payload's shape and *before* the row hits
Prisma:

1. Walk the event payload schema (or the version's `input_schema` for
   session-create) for every site marked `format: pane-blob-id`.
2. Collect every concrete string at those sites in the payload.
3. Batch-query the `Blob` table for those ids, filtered by
   `ownerId = <session's agent> AND deletedAt IS NULL`.
4. Any id that doesn't come back → 422 `blob_ref_not_accessible`.

Implementation: `packages/relay/src/blobs/ref-access.ts` (the walker +
the DB check). The check is wired into `writeEvent` (so HTTP + WS event
paths both get it) and into `POST /v1/sessions` after Ajv-validating
`input_data`.

The 422 error response collapses three failure modes into one — wrong
id, wrong owner, soft-deleted — so an attacker probing blob ids can't
distinguish "this id exists but isn't mine" from "this id doesn't
exist at all".

### Known limitation: scope is NOT enforced (yet)

The check verifies **ownership**, not **scope**. A session-scope blob
created for session A is currently accepted in an event on session B
as long as the calling agent owns it. The cross-tenant story is
already gated (agent X can never reference agent Y's blob), and that's
the load-bearing property; tightening session-scope to "must match THIS
session" is a follow-up.

## Related

- [`docs/BLOB_BACKENDS.md`](./BLOB_BACKENDS.md) — backend compatibility matrix
- [`docs/CAPABILITY-URLS.md`](./CAPABILITY-URLS.md) — `/b/<token>` threat model
- Proposal: [pane#152](https://github.com/aerolalit/paneui/issues/152)
- Verification tracking: [pane#153](https://github.com/aerolalit/paneui/issues/153)
