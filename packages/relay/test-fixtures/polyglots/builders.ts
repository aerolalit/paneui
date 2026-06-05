// One builder per fixture. Each is keyed by the fixture name that
// matches the corresponding `<name>.meta.json` sidecar under `meta/`.
//
// Builders are deterministic — for the same Node + sharp + zlib versions
// they produce the same bytes. That keeps the test corpus reproducible
// across CI runs.
//
// The fixtures cover four threat classes:
//   1. Appended payloads after the image's terminator (HTML / ZIP / EXE)
//   2. In-format text/comment chunks carrying executable strings
//   3. EXIF / metadata smuggling
//   4. Pass-through MIMEs (svg, pdf, heic) — documented as out-of-scope
//      for libvips normalisation, included so the test asserts the
//      *actual* behaviour (no normalisation, bytes pass through).
//
// Adding a fixture: drop a builder here, drop a `<name>.meta.json` in
// `meta/`, the corpus loader pairs them automatically.

import sharp from "sharp";
import {
  baselines,
  deflateSync,
  injectBeforeIend,
  injectJpegComSegment,
  pngChunk,
  tinyZipTrailer,
} from "./utils.js";

const HTML_SCRIPT = Buffer.from(
  "<html><body><script>alert('xss-polyglot')</script></body></html>",
  "utf8",
);
const PE_DOS_STUB = Buffer.from(
  "MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00FAKE-PE-POLYGLOT",
  "binary",
);

export type Builder = () => Promise<Buffer>;

// ── JPEG ────────────────────────────────────────────────────────────────

const jpegHtmlAfterEoi: Builder = async () =>
  Buffer.concat([await baselines.jpeg(), HTML_SCRIPT]);

const jpegScriptInComSegment: Builder = async () => {
  const base = await baselines.jpeg();
  const payload = Buffer.from(
    "<script>alert('com-segment-polyglot')</script>",
    "utf8",
  );
  return injectJpegComSegment(base, payload);
};

const jpegScriptInExifComment: Builder = async () =>
  sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: 80, g: 80, b: 80 },
    },
  })
    .withExif({
      IFD0: {
        ImageDescription: "<script>alert('exif-polyglot')</script>",
        Artist: "exif-leak-test",
      },
    })
    .jpeg()
    .toBuffer();

const jpegNestedHtmlJpeg: Builder = async () => {
  const outer = await baselines.jpeg();
  // A fake "inner JPEG" — SOI ... HTML ... EOI. Not a valid JPEG on its
  // own; the point is that a *naive* parser walking SOI/EOI markers
  // could be fooled. The sharp re-encode of the outer drops everything
  // after the outer's real EOI.
  const fakeInner = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    HTML_SCRIPT,
    Buffer.from([0xff, 0xd9]),
  ]);
  return Buffer.concat([outer, fakeInner]);
};

const jpegZipTrailer: Builder = async () =>
  Buffer.concat([await baselines.jpeg(), tinyZipTrailer("hidden.txt")]);

const jpegExeTrailer: Builder = async () =>
  Buffer.concat([await baselines.jpeg(), PE_DOS_STUB]);

// ── PNG ─────────────────────────────────────────────────────────────────

const pngScriptInItxt: Builder = async () => {
  const base = await baselines.png();
  // iTXt chunk layout:
  //   keyword (latin1) NUL <compress-flag:1> <method:1> language NUL
  //   translated NUL text (utf8)
  const data = Buffer.concat([
    Buffer.from("Comment", "latin1"),
    Buffer.from([0x00, 0x00, 0x00]),
    Buffer.from([0x00, 0x00]), // language NUL, translated NUL
    Buffer.from("<script>alert('itxt-polyglot')</script>", "utf8"),
  ]);
  return injectBeforeIend(base, pngChunk("iTXt", data));
};

const pngScriptInZtxt: Builder = async () => {
  const base = await baselines.png();
  // zTXt: keyword NUL <method:1=0=deflate> compressed-text
  const compressed = deflateSync(
    Buffer.from("<script>alert('ztxt-polyglot')</script>", "utf8"),
  );
  const data = Buffer.concat([
    Buffer.from("Comment", "latin1"),
    Buffer.from([0x00, 0x00]),
    compressed,
  ]);
  return injectBeforeIend(base, pngChunk("zTXt", data));
};

const pngScriptInText: Builder = async () => {
  const base = await baselines.png();
  // tEXt: keyword NUL text (latin1)
  const data = Buffer.concat([
    Buffer.from("Comment", "latin1"),
    Buffer.from([0x00]),
    Buffer.from("<script>alert('text-polyglot')</script>", "latin1"),
  ]);
  return injectBeforeIend(base, pngChunk("tEXt", data));
};

const pngDataAfterIend: Builder = async () =>
  Buffer.concat([
    await baselines.png(),
    Buffer.from("APPENDED-AFTER-IEND-PAYLOAD", "latin1"),
  ]);

const pngHtmlAfterIend: Builder = async () =>
  Buffer.concat([await baselines.png(), HTML_SCRIPT]);

const pngJarAfterIend: Builder = async () =>
  Buffer.concat([await baselines.png(), tinyZipTrailer("malicious.class")]);

// ── GIF ─────────────────────────────────────────────────────────────────

const gifHtmlAfterTerminator: Builder = async () =>
  Buffer.concat([await baselines.gif(), HTML_SCRIPT]);

const gifar: Builder = async () =>
  Buffer.concat([await baselines.gif(), tinyZipTrailer("Applet.class")]);

const gifJsAfterTerminator: Builder = async () =>
  Buffer.concat([
    await baselines.gif(),
    Buffer.from("<script>alert('gif-trailer-polyglot')</script>", "utf8"),
  ]);

// ── WebP ────────────────────────────────────────────────────────────────

const webpZipTrailer: Builder = async () =>
  Buffer.concat([await baselines.webp(), tinyZipTrailer("hidden.txt")]);

const webpExtraRiffChunks: Builder = async () => {
  // RIFF allows trailing data after the declared chunk size. Some
  // parsers (and some browsers) keep walking; sharp's decode-encode
  // produces a fresh RIFF with only the legitimate VP8 / VP8L data.
  const base = await baselines.webp();
  return Buffer.concat([
    base,
    Buffer.from("BOGUSCHUNKHEADERhtml-payload<script>x</script>", "binary"),
  ]);
};

const webpHtmlAfterEnd: Builder = async () =>
  Buffer.concat([await baselines.webp(), HTML_SCRIPT]);

// ── SVG (F-13: rasterised to PNG, not passed through) ───────────────────

// A scripted SVG exercising every vector the rasterise pass must drop:
// inline <script>, an onload handler, a javascript: xlink:href, and a
// <foreignObject> with an onerror handler. After rasterisation to PNG none
// of this markup survives — the output is pure pixel data.
const svgWithScript: Builder = async () =>
  Buffer.from(
    `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="16" height="16" onload="alert('svg-onload')">
  <rect width="16" height="16" fill="red"/>
  <script type="application/javascript">alert('svg-inline-script')</script>
  <a xlink:href="javascript:alert('svg-xlink')"><rect width="4" height="4"/></a>
  <foreignObject width="8" height="8"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert('fo')"/></body></foreignObject>
</svg>`,
    "utf8",
  );

const pdfWithJsAction: Builder = async () =>
  Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj",
      "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (alert\\('pdf-polyglot'\\);) >> >>",
      "endobj",
      "2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj",
      "xref",
      "trailer << /Root 1 0 R /Size 3 >>",
      "%%EOF",
    ].join("\n"),
    "utf8",
  );

const heicWithHtmlTrailer: Builder = async () => {
  // We don't generate a real HEIC — the mime-sniffer accepts the
  // `ftypheic` box at offset 4 + length prefix. This fixture is a
  // syntactically-recognisable HEIC head followed by HTML, used to
  // verify the pass-through MIME stays pass-through.
  const head = Buffer.from(
    "\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heicmiaf",
    "binary",
  );
  return Buffer.concat([head, HTML_SCRIPT]);
};

// ── Clean baselines (negative controls) ─────────────────────────────────

const cleanJpeg: Builder = async () => baselines.jpeg(32, 32);
const cleanPng: Builder = async () => baselines.png(32, 32);
const cleanGif: Builder = async () => baselines.gif(32, 32);
const cleanWebp: Builder = async () => baselines.webp(32, 32);

// ── Registry ────────────────────────────────────────────────────────────

export const builders: Record<string, Builder> = {
  "jpeg-html-after-eoi": jpegHtmlAfterEoi,
  "jpeg-script-in-com-segment": jpegScriptInComSegment,
  "jpeg-script-in-exif-comment": jpegScriptInExifComment,
  "jpeg-nested-html-jpeg": jpegNestedHtmlJpeg,
  "jpeg-zip-trailer": jpegZipTrailer,
  "jpeg-exe-trailer": jpegExeTrailer,
  "png-script-in-itxt": pngScriptInItxt,
  "png-script-in-ztxt": pngScriptInZtxt,
  "png-script-in-text": pngScriptInText,
  "png-data-after-iend": pngDataAfterIend,
  "png-html-after-iend": pngHtmlAfterIend,
  "png-jar-after-iend": pngJarAfterIend,
  "gif-html-after-terminator": gifHtmlAfterTerminator,
  gifar: gifar,
  "gif-js-after-terminator": gifJsAfterTerminator,
  "webp-zip-trailer": webpZipTrailer,
  "webp-extra-riff-chunks": webpExtraRiffChunks,
  "webp-html-after-end": webpHtmlAfterEnd,
  "svg-with-script": svgWithScript,
  "pdf-with-js-action": pdfWithJsAction,
  "heic-with-html-trailer": heicWithHtmlTrailer,
  "clean-jpeg": cleanJpeg,
  "clean-png": cleanPng,
  "clean-gif": cleanGif,
  "clean-webp": cleanWebp,
};
