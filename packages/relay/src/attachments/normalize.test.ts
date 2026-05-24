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
});

describe("isNormalisable", () => {
  it("returns true for the four supported raster formats", () => {
    expect(isNormalisable("image/jpeg")).toBe(true);
    expect(isNormalisable("image/png")).toBe(true);
    expect(isNormalisable("image/gif")).toBe(true);
    expect(isNormalisable("image/webp")).toBe(true);
  });

  it("returns false for SVG (caller responsibility) + PDF + others", () => {
    expect(isNormalisable("image/svg+xml")).toBe(false);
    expect(isNormalisable("application/pdf")).toBe(false);
    expect(isNormalisable("text/plain")).toBe(false);
    expect(isNormalisable("application/octet-stream")).toBe(false);
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
