// Polyglot defense + EXIF strip — driven by the tracked corpus under
// `packages/relay/test-fixtures/polyglots/`. Every fixture in the corpus
// runs through `normaliseImage()` and is asserted against the contract
// declared in its `<name>.meta.json` sidecar.
//
// Adding a fixture is purely a matter of adding a builder + sidecar; no
// changes to this file are needed.

import { describe, it, expect } from "vitest";
import sharp from "sharp";

import { corpus, type Fixture } from "../../test-fixtures/polyglots/index.js";
import { baselines } from "../../test-fixtures/polyglots/utils.js";
import {
  ImageNormalisationError,
  isNormalisable,
  MAX_IMAGE_PIXELS,
  normaliseImage,
} from "./normalize.js";

// Sanity: keep the floor visible in test output so a future drop in
// corpus size shows up as a failed expectation, not a silent shrink.
const MIN_CORPUS_FIXTURES = 20;

describe("polyglot corpus", () => {
  it(`has at least ${MIN_CORPUS_FIXTURES} fixtures`, () => {
    expect(corpus.length).toBeGreaterThanOrEqual(MIN_CORPUS_FIXTURES);
  });

  it("covers every normalisable MIME with at least one fixture", () => {
    const mimes = new Set(corpus.map((f) => f.mime));
    for (const m of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      expect(mimes.has(m)).toBe(true);
    }
  });

  it("registers every fixture under exactly one of the known threat classes", () => {
    const allowed = new Set([
      "appended-payload",
      "in-format-chunk",
      "metadata",
      "passthrough-untouched",
      "baseline",
    ]);
    for (const f of corpus) {
      expect(allowed.has(f.threatClass)).toBe(true);
    }
  });
});

// One describe block per fixture. Each runs against the real normaliser
// and asserts the contract in the sidecar.
for (const fixture of corpus) {
  describe(`fixture: ${fixture.name} (${fixture.threatClass})`, () => {
    it("matches its sidecar contract", async () => {
      await runFixture(fixture);
    });
  });
}

async function runFixture(fixture: Fixture): Promise<void> {
  const input = await fixture.buildBytes();
  const result = await normaliseImage({
    bytes: input,
    mime: fixture.mime,
  });

  // 1. normalised flag.
  if (fixture.assertions.normalised !== undefined) {
    expect(result.normalised).toBe(fixture.assertions.normalised);
  }

  // 2. Pass-through bytes are unchanged.
  if (fixture.assertions.bytesUnchanged) {
    expect(result.bytes.equals(input)).toBe(true);
  }

  // 3. No forbidden substrings in the output.
  if (fixture.assertions.outputDoesNotContain) {
    const out = result.bytes.toString("latin1");
    for (const needle of fixture.assertions.outputDoesNotContain) {
      expect(
        out,
        `polyglot tail "${needle}" survived normalisation`,
      ).not.toContain(needle);
    }
  }

  // 4. Dimensions preserved across the strip (baseline fixtures).
  if (fixture.assertions.dimensionsPreserved) {
    const inMeta = await sharp(input).metadata();
    expect(result.width).toBe(inMeta.width);
    expect(result.height).toBe(inMeta.height);
  }

  // 5. Idempotency — normalising the output again is byte-stable.
  if (fixture.assertions.idempotent) {
    const second = await normaliseImage({
      bytes: result.bytes,
      mime: result.mime,
    });
    expect(second.bytes.equals(result.bytes)).toBe(true);
    expect(second.sha256).toBe(result.sha256);
  }

  // 6. EXIF strip removed the metadata segment.
  if (fixture.assertions.exifAfterStripUndefined) {
    const meta = await sharp(result.bytes).metadata();
    expect(meta.exif).toBeUndefined();
  }
}

// ── Targeted tests — properties that are awkward to express as sidecar
// assertions but still worth pinning. ─────────────────────────────────

describe("normaliseImage — focused properties", () => {
  it("rejects bytes that don't decode as the declared image format", async () => {
    const notAnImage = Buffer.from(
      "<!doctype html><html><body>just html</body></html>",
      "utf8",
    );
    await expect(
      normaliseImage({ bytes: notAnImage, mime: "image/jpeg" }),
    ).rejects.toBeInstanceOf(ImageNormalisationError);
  });

  it("changes the bytes (and sha256) when EXIF is removed", async () => {
    const fixture = corpus.find(
      (f) => f.name === "jpeg-script-in-exif-comment",
    );
    expect(
      fixture,
      "jpeg-script-in-exif-comment fixture must exist",
    ).toBeDefined();
    const input = await fixture!.buildBytes();
    const result = await normaliseImage({
      bytes: input,
      mime: "image/jpeg",
    });
    expect(result.bytes.equals(input)).toBe(false);
    const { createHash } = await import("node:crypto");
    const inputHash = createHash("sha256").update(input).digest("hex");
    expect(result.sha256).not.toBe(inputHash);
  });

  it("reports the right dimensions on a wide image", async () => {
    const j = await baselines.jpeg(64, 16);
    const result = await normaliseImage({ bytes: j, mime: "image/jpeg" });
    expect(result.width).toBe(64);
    expect(result.height).toBe(16);
  });

  // F-17 — decompression-bomb headroom. Input bytes are capped at
  // MAX_BLOB_BYTES, but a small highly-compressed image can declare huge
  // dimensions. A solid-colour PNG just over MAX_IMAGE_PIXELS compresses to
  // well under the 5 MB blob cap, yet must be rejected by the explicit
  // limitInputPixels ceiling — via the same ImageNormalisationError path a
  // malformed image takes (route maps it to 415).
  it("rejects an image whose pixel count exceeds MAX_IMAGE_PIXELS", async () => {
    // Pick a near-square frame just past the ceiling (~50.4 MP > 50 MP).
    const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 50;
    const bomb = await sharp({
      create: {
        width: side,
        height: side,
        channels: 3,
        background: "#abcdef",
      },
    })
      .png()
      .toBuffer();
    // Sanity: the crafted bomb is small enough to slip under the byte cap
    // (the whole point of the finding — bytes are bounded, pixels are not).
    expect(bomb.length).toBeLessThan(5_000_000);
    await expect(
      normaliseImage({ bytes: bomb, mime: "image/png" }),
    ).rejects.toBeInstanceOf(ImageNormalisationError);
  });

  it("accepts an image comfortably under MAX_IMAGE_PIXELS", async () => {
    const ok = await baselines.png(256, 256);
    const result = await normaliseImage({ bytes: ok, mime: "image/png" });
    expect(result.normalised).toBe(true);
    expect(result.width).toBe(256);
    expect(result.height).toBe(256);
  });
});

describe("isNormalisable", () => {
  it("returns true for the four supported raster formats", () => {
    expect(isNormalisable("image/jpeg")).toBe(true);
    expect(isNormalisable("image/png")).toBe(true);
    expect(isNormalisable("image/gif")).toBe(true);
    expect(isNormalisable("image/webp")).toBe(true);
  });

  it("returns true for SVG (F-13: rasterised to PNG by normaliseImage)", () => {
    expect(isNormalisable("image/svg+xml")).toBe(true);
  });

  it("returns false for PDF + others", () => {
    expect(isNormalisable("application/pdf")).toBe(false);
    expect(isNormalisable("text/plain")).toBe(false);
    expect(isNormalisable("application/octet-stream")).toBe(false);
  });
});

// ── F-13 — SVG rasterisation ──────────────────────────────────────────
//
// When an operator opts SVG back into BLOB_MIME_ALLOWLIST, an accepted SVG
// reaches normaliseImage(), which rasterises it to PNG. Every executable
// vector (script / onload / javascript: / foreignObject) is dropped because
// none of it survives the vector→bitmap decode, and the stored mime changes
// to image/png so the caller persists a consistent row.

describe("normaliseImage — SVG rasterisation (F-13)", () => {
  const scriptedSvg = Buffer.from(
    `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20" onload="alert('onload')">
  <rect width="20" height="20" fill="#3366cc"/>
  <script type="application/javascript">alert('inline-script')</script>
  <a xlink:href="javascript:alert('xlink')"><rect width="4" height="4"/></a>
  <foreignObject width="8" height="8"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert('fo')"/></body></foreignObject>
</svg>`,
    "utf8",
  );

  it("transcodes a scripted SVG to PNG and drops all executable content", async () => {
    const result = await normaliseImage({
      bytes: scriptedSvg,
      mime: "image/svg+xml",
    });

    // Stored mime is PNG, not svg.
    expect(result.mime).toBe("image/png");
    expect(result.normalised).toBe(true);

    // Output is a valid raster image with sensible dimensions.
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe("png");
    expect(result.width).toBe(20);
    expect(result.height).toBe(20);

    // None of the SVG/script markup survives the rasterisation.
    const out = result.bytes.toString("latin1");
    for (const needle of [
      "<script",
      "onload",
      "javascript:",
      "onerror",
      "foreignObject",
      "<svg",
    ]) {
      expect(out, `"${needle}" survived SVG rasterisation`).not.toContain(
        needle,
      );
    }
  });

  it("rejects malformed SVG XML via ImageNormalisationError", async () => {
    // librsvg refuses to parse non-XML / non-SVG content sniffed as svg.
    const broken = Buffer.from("<svg>not closed and not valid", "utf8");
    await expect(
      normaliseImage({ bytes: broken, mime: "image/svg+xml" }),
    ).rejects.toBeInstanceOf(ImageNormalisationError);
  });
});

// ── F-17 — bounded concurrency ────────────────────────────────────────
//
// normaliseImage() acquires a permit from an in-process semaphore (bound 4)
// around the sharp decode so a burst of large uploads can't collectively
// exhaust memory. These tests assert (a) concurrency doesn't break the happy
// path and (b) the permit is released even when a decode throws (no leak).

describe("normaliseImage — bounded concurrency (F-17)", () => {
  it("processes many concurrent normalisations correctly", async () => {
    const inputs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        baselines.png(32 + (i % 8), 32 + (i % 8)),
      ),
    );
    const results = await Promise.all(
      inputs.map((bytes) => normaliseImage({ bytes, mime: "image/png" })),
    );
    expect(results).toHaveLength(20);
    for (const r of results) {
      expect(r.normalised).toBe(true);
      expect(r.mime).toBe("image/png");
      expect(r.bytes.length).toBeGreaterThan(0);
    }
  });

  it("does not leak a permit when a decode throws (failures + successes interleaved)", async () => {
    const good = await baselines.png(48, 48);
    const bad = Buffer.from("<!doctype html><html></html>", "utf8");

    // Fire far more than the bound (4), interleaving failures with successes.
    // If a throwing decode leaked its permit, the pool would drain and the
    // trailing successes would hang forever — the test would time out. That
    // it resolves at all proves the finally-release works.
    const tasks: Array<Promise<unknown>> = [];
    for (let i = 0; i < 24; i++) {
      if (i % 2 === 0) {
        tasks.push(
          normaliseImage({ bytes: good, mime: "image/png" }).then((r) => ({
            ok: true as const,
            mime: r.mime,
          })),
        );
      } else {
        tasks.push(
          normaliseImage({ bytes: bad, mime: "image/png" }).then(
            () => ({ ok: true as const, mime: "image/png" }),
            (e) => ({ ok: false as const, err: e }),
          ),
        );
      }
    }
    const settled = await Promise.all(tasks);
    const oks = settled.filter((s) => (s as { ok: boolean }).ok);
    const fails = settled.filter((s) => !(s as { ok: boolean }).ok);
    expect(oks).toHaveLength(12);
    expect(fails).toHaveLength(12);
    for (const f of fails) {
      expect((f as { err: unknown }).err).toBeInstanceOf(
        ImageNormalisationError,
      );
    }
  });
});

// ── Negative-control meta-test ────────────────────────────────────────
//
// Proves the corpus has teeth: a deliberately broken "normaliser" that
// just passes the bytes through is run against the stripped fixtures.
// AT LEAST ONE outputDoesNotContain assertion must fail — confirming
// that if normalize.ts ever regresses to a pass-through, the corpus
// will catch it.
//
// Picking jpeg-html-after-eoi as the canary: it's the simplest fixture
// (appended HTML after EOI) and the assertion is unambiguous (output
// must not contain "<script>" — the polyglot tail).

describe("corpus has teeth (negative control)", () => {
  it("a pass-through 'normaliser' fails the jpeg-html-after-eoi assertions", async () => {
    const fixture = corpus.find((f) => f.name === "jpeg-html-after-eoi");
    expect(fixture, "fixture must exist").toBeDefined();

    const input = await fixture!.buildBytes();
    // brokenNormalise: returns the input unchanged. Exactly the
    // behaviour we'd get if someone commented out the sharp re-encode
    // in normalize.ts. The polyglot tail survives.
    const brokenResult = { bytes: input };

    const out = brokenResult.bytes.toString("latin1");
    // The polyglot tail IS in the broken output — proves a regression
    // would be detected by the real corpus run above.
    expect(out).toContain("<script>");
    expect(out).toContain("</html>");
  });

  it("a pass-through 'normaliser' fails the png-html-after-iend assertions", async () => {
    const fixture = corpus.find((f) => f.name === "png-html-after-iend");
    expect(fixture, "fixture must exist").toBeDefined();
    const input = await fixture!.buildBytes();
    const out = input.toString("latin1");
    expect(out).toContain("<script>");
  });
});
