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
"sharp": "^0.34.0"
```

Any minor bump re-runs the full polyglot test suite before merge.

## Pass-through MIMEs and their risks

| MIME | Posture | Why |
|------|---------|-----|
| `image/jpeg`, `image/png`, `image/gif`, `image/webp` | Normalised | sharp re-encodes; polyglot tails dropped |
| `image/svg+xml` | **Pass-through** | SVG carries `<script>` + event handlers as a feature; needs an XML sanitiser (out of scope for v0.1.0) |
| `application/pdf` | Pass-through | Served with `Content-Disposition: attachment` to prevent inline render |
| Anything else | Rejected by allowlist | Default `BLOB_MIME_ALLOWLIST=image/,application/pdf` |

### Operator note: SVG

If your surface renders SVGs inline in untrusted UI (e.g. as `<img>` from
a `/b/<token>` URL inside a participant page), **remove `image/svg+xml`
from the allowlist** until v0.2's SVG sanitiser ships:

```
BLOB_MIME_ALLOWLIST=image/jpeg,image/png,image/gif,image/webp,application/pdf
```

This is the right default for hosted Pane.

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

- **sharp pinned** to `^0.34.0` in `packages/relay/package.json`.
- Dependabot opens patch-version bumps within 24h of upstream release.
- Minor bumps (`0.34.x → 0.35.x`) require manual review + a corpus rerun
  before merge — never auto-merged.
- Major bumps go through a full security review (the encoder semantics
  may shift between sharp majors).

## Related

- [`docs/BLOB_BACKENDS.md`](./BLOB_BACKENDS.md) — backend compatibility matrix
- [`docs/CAPABILITY-URLS.md`](./CAPABILITY-URLS.md) — `/b/<token>` threat model
- Proposal: [pane#152](https://github.com/aerolalit/paneui/issues/152)
- Verification tracking: [pane#153](https://github.com/aerolalit/paneui/issues/153)
