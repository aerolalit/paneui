// Corpus loader. Reads every `<name>.meta.json` sidecar under `meta/`,
// resolves the matching builder from `builders.ts`, and returns an
// assembled list of {name, mime, threatClass, bytes, ...} entries that
// normalize.test.ts iterates.
//
// The pairing is enforced symmetrically:
//   * Every meta file MUST have a builder of the same name.
//   * Every builder MUST have a meta file.
// A meta-without-builder or builder-without-meta throws at load time
// rather than silently dropping a fixture.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { builders } from "./builders.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const META_DIR = join(HERE, "meta");

export type ThreatClass =
  | "appended-payload"
  | "in-format-chunk"
  | "metadata"
  | "passthrough-untouched"
  | "baseline";

export type ExpectedNormalisation = "stripped" | "pass-through" | "clean";

export interface FixtureMeta {
  name: string;
  mime: string;
  threatClass: ThreatClass;
  source: string;
  description: string;
  expectedNormalisation: ExpectedNormalisation;
  assertions: {
    /** Sharp must have processed the bytes (normalised=true) — true for
     * stripped + clean; false for pass-through. */
    normalised?: boolean;
    /** Strings the normalised output must NOT contain (matched on
     * latin1 to catch raw bytes regardless of encoding). */
    outputDoesNotContain?: string[];
    /** The fixture's bytes must come back unchanged (pass-through). */
    bytesUnchanged?: boolean;
    /** Re-running normalise on the output produces identical bytes. */
    idempotent?: boolean;
    /** Output width/height match the input. */
    dimensionsPreserved?: boolean;
    /** Sharp's metadata reader returns undefined for `exif` after strip. */
    exifAfterStripUndefined?: boolean;
  };
}

export interface Fixture extends FixtureMeta {
  /** Lazily built bytes for the fixture. Cached after first call. */
  readonly buildBytes: () => Promise<Buffer>;
}

function loadMeta(): FixtureMeta[] {
  const files = readdirSync(META_DIR).filter((f) => f.endsWith(".meta.json"));
  return files.map((f) => {
    const raw = readFileSync(join(META_DIR, f), "utf8");
    const parsed = JSON.parse(raw) as FixtureMeta;
    const expectedName = f.replace(/\.meta\.json$/, "");
    if (parsed.name !== expectedName) {
      throw new Error(
        `meta file ${f}: name field "${parsed.name}" must match filename`,
      );
    }
    return parsed;
  });
}

function assemble(): Fixture[] {
  const metas = loadMeta();
  const builderNames = new Set(Object.keys(builders));
  const metaNames = new Set(metas.map((m) => m.name));

  // Symmetry check — fail loudly when corpus drifts.
  for (const m of metas) {
    if (!builderNames.has(m.name)) {
      throw new Error(
        `meta "${m.name}" has no builder in builders.ts — add one or remove the meta file`,
      );
    }
  }
  for (const b of builderNames) {
    if (!metaNames.has(b)) {
      throw new Error(
        `builder "${b}" has no meta file in meta/ — add a sidecar or remove the builder`,
      );
    }
  }

  return metas.map((m) => {
    let cached: Buffer | undefined;
    return {
      ...m,
      buildBytes: async () => {
        if (cached) return cached;
        cached = await builders[m.name]();
        return cached;
      },
    };
  });
}

export const corpus: Fixture[] = assemble();
