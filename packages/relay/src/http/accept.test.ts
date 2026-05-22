// Unit tests for the RFC 9110 Accept-header negotiator. The bridge depends
// on `prefersHtml` correctly distinguishing browser-style Accept headers
// from agent/curl ones — the wrong call here turns the human-facing error
// page back into a JSON envelope (or vice-versa, exposing the envelope to
// browsers).

import { describe, it, expect } from "vitest";
import { parseAccept, selectMediaType, prefersHtml } from "./accept.js";

describe("parseAccept", () => {
  it("defaults to */* when the header is missing or empty", () => {
    expect(parseAccept(undefined)).toEqual([
      { type: "*", subtype: "*", q: 1, specificity: 1 },
    ]);
    expect(parseAccept("")).toEqual([
      { type: "*", subtype: "*", q: 1, specificity: 1 },
    ]);
  });

  it("parses a single explicit type with q=1 by default", () => {
    expect(parseAccept("text/html")).toEqual([
      { type: "text", subtype: "html", q: 1, specificity: 3 },
    ]);
  });

  it("parses q-values", () => {
    const parsed = parseAccept("text/html;q=0.5,application/json;q=0.9");
    expect(parsed).toEqual([
      { type: "text", subtype: "html", q: 0.5, specificity: 3 },
      { type: "application", subtype: "json", q: 0.9, specificity: 3 },
    ]);
  });

  it("computes specificity for wildcards", () => {
    const parsed = parseAccept("text/html, text/*, */*");
    expect(parsed.map((p) => p.specificity)).toEqual([3, 2, 1]);
  });

  it("skips malformed entries without throwing", () => {
    const parsed = parseAccept("text/html, not-a-type, application/json");
    expect(parsed.map((p) => `${p.type}/${p.subtype}`)).toEqual([
      "text/html",
      "application/json",
    ]);
  });
});

describe("selectMediaType", () => {
  it("picks the offer matching the explicit type", () => {
    expect(
      selectMediaType("text/html", ["application/json", "text/html"]),
    ).toBe("text/html");
  });

  it("returns null when nothing matches", () => {
    expect(
      selectMediaType("image/png", ["application/json", "text/html"]),
    ).toBeNull();
  });

  it("breaks q-value ties with server preference (offers order)", () => {
    // Both at q=1 → first offer wins.
    expect(
      selectMediaType("text/html, application/json", [
        "application/json",
        "text/html",
      ]),
    ).toBe("application/json");
    expect(
      selectMediaType("text/html, application/json", [
        "text/html",
        "application/json",
      ]),
    ).toBe("text/html");
  });

  it("respects q-value ranking over offer order", () => {
    expect(
      selectMediaType("text/html;q=0.9, application/json", [
        "text/html",
        "application/json",
      ]),
    ).toBe("application/json");
  });

  it("prefers a specific match over a wildcard at the same q", () => {
    // `text/html` is q=1 explicitly; `*/*;q=1` would also match application/json.
    // The HTML offer is more specific, so it wins.
    expect(
      selectMediaType("text/html, */*", ["application/json", "text/html"]),
    ).toBe("text/html");
  });

  it("respects q=0 as a hard exclusion", () => {
    expect(
      selectMediaType("text/html, application/json;q=0", [
        "application/json",
        "text/html",
      ]),
    ).toBe("text/html");
  });

  it("returns null when */*;q=0 explicitly excludes everything", () => {
    expect(
      selectMediaType("text/html;q=0, */*;q=0", [
        "application/json",
        "text/html",
      ]),
    ).toBeNull();
  });
});

describe("prefersHtml", () => {
  // The three Accept headers the bridge actually has to handle in production.
  it("returns true for a browser", () => {
    // Chrome / Firefox / Safari all send something like this.
    expect(
      prefersHtml(
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      ),
    ).toBe(true);
  });

  it("returns false for curl with no override (*/*)", () => {
    expect(prefersHtml("*/*")).toBe(false);
  });

  it("returns false for an explicit JSON client", () => {
    expect(prefersHtml("application/json")).toBe(false);
  });

  it("returns false when the header is missing", () => {
    expect(prefersHtml(undefined)).toBe(false);
    expect(prefersHtml(null)).toBe(false);
  });

  it("returns false when HTML has a lower q than JSON", () => {
    expect(prefersHtml("application/json, text/html;q=0.5")).toBe(false);
  });

  it("returns true when only HTML is offered", () => {
    expect(prefersHtml("text/html")).toBe(true);
  });
});
