# Polyglot test corpus

Tracked attack corpus for the attachment-attachment polyglot defense
(`packages/relay/src/attachments/normalize.ts`).

Tracking issue: [pane#153](https://github.com/aerolalit/paneui/issues/153) —
verifies the polyglot strip claim of [pane#152](https://github.com/aerolalit/paneui/issues/152).

## What's here

```
test-fixtures/polyglots/
├── README.md       ← this file
├── builders.ts     ← byte-generators (one per fixture)
├── utils.ts        ← png-chunk + crc32 + jpeg-COM + tiny-ZIP helpers
├── index.ts        ← corpus loader: pairs meta files with builders
└── meta/
    └── <name>.meta.json   ← sidecar metadata per fixture
```

Every fixture has two paired files:

- A **builder** in [`builders.ts`](./builders.ts) keyed by `<name>` —
  pure TypeScript that emits the polyglot bytes deterministically. No
  binary attachments checked in.
- A **sidecar** at [`meta/<name>.meta.json`](./meta) documenting the
  fixture's `mime`, `threatClass`, `source`, `description`,
  `expectedNormalisation`, and `assertions`.

The corpus loader ([`index.ts`](./index.ts)) enforces that the two
sides stay symmetric: every builder needs a sidecar, every sidecar
needs a builder. Missing pairs throw at test load time.

## What it covers

25 fixtures across five threat classes:

| Threat class | Count | Examples |
|--------------|-------|----------|
| `appended-payload` | 12 | HTML / EXE / ZIP appended after JPEG EOI, PNG IEND, GIF terminator, WebP RIFF |
| `in-format-chunk` | 4 | JPEG COM segment, PNG iTXt / zTXt / tEXt with script payloads |
| `metadata` | 1 | EXIF IFD0 with script-shaped Artist / ImageDescription |
| `passthrough-untouched` | 3 | SVG inline `<script>`, PDF `/JS` action, HEIC + HTML trailer (documents what we *don't* normalise) |
| `baseline` | 4 | known-good JPEG / PNG / GIF / WebP (verifies the normaliser preserves legitimate content) |

## Adding a fixture

1. Write a builder in [`builders.ts`](./builders.ts):
   ```ts
   const myNewPolyglot: Builder = async () => {
     // … produce raw bytes
   };
   ```
2. Register it under a name in the `builders` map at the bottom of the file.
3. Drop a matching `meta/<name>.meta.json` sidecar.
4. Run `npm test -- normalize.test.ts` from `packages/relay/`. The corpus
   loader picks up the new fixture automatically.

## Why generated, not checked in

The acceptance criterion says "tracked directory of attack files." We
satisfy the spirit with **tracked builders**:

- **Reviewable.** A new fixture is a TypeScript function in a PR
  diff. Reviewers can see exactly what bytes are produced, not a
  base64 attachment.
- **Reproducible.** The same `(node, sharp, zlib)` versions produce
  the same bytes on every CI run. No drift between developer machines
  and CI.
- **Diff-friendly.** When sharp ships a behaviour change, the diff
  shows up in the test assertions — not as a binary attachment mystery.
- **No licensing ambiguity.** Hand-authored bytes only; no copied
  fixtures from third-party corpora that would carry their own
  attribution / license requirements.

If a real-world bypass shows up that's awkward to express as a
builder, we'll commit the raw bytes as `meta/<name>.bin` alongside the
sidecar and let the builder read from disk. That escape hatch isn't
needed for the v0.1.0 corpus.

## Sources

All fixtures are hand-authored — no copied bytes from public corpora.
Where a fixture's *shape* echoes a historical attack (GIFAR; jpeg-zip
polyglots), the meta file's `source` field records the attribution
even though the bytes are original.

External corpora worth knowing about (not currently imported):
- [Polydet/polyglot-database](https://github.com/Polydet/polyglot-database)
- Ange Albertini, "Funky File Formats"
- Corkami's polyglot examples
- Stevens / Mandiant 2008 GIFAR writeups

The `meta/<name>.meta.json` sidecar is the place to credit a source
if a future fixture lands as a direct adaptation.

## Reporting a bypass

If you can construct a file that:

1. Passes our MIME sniffer (`packages/relay/src/attachments/mime-sniff.ts`)
2. Survives `normaliseImage()` with malicious payload intact

…please **don't** open a public issue. Email the maintainer (see
`SECURITY.md`) with a sample file. The corpus is meant to grow
forever — every bypass that ever worked stays here as a regression
test, even after the underlying library is patched.
