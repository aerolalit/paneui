import { describe, it, expect } from "vitest";
import { fallbackTagFromName, templateTagsWithFallback } from "./tags.js";

describe("fallbackTagFromName", () => {
  it("kebab-cases a normal name", () => {
    expect(fallbackTagFromName("Quick Poll")).toEqual(["quick-poll"]);
    expect(fallbackTagFromName("Plain")).toEqual(["plain"]);
  });

  it("collapses runs of punctuation/whitespace and trims edges", () => {
    expect(fallbackTagFromName("  PR Review!! (v2) ")).toEqual([
      "pr-review-v2",
    ]);
    expect(fallbackTagFromName("a___b---c")).toEqual(["a-b-c"]);
  });

  it("returns [] when nothing usable survives", () => {
    expect(fallbackTagFromName("✨")).toEqual([]);
    expect(fallbackTagFromName("   ")).toEqual([]);
    expect(fallbackTagFromName("---")).toEqual([]);
  });

  it("drops reserved names (the star is a favorite, not a tag)", () => {
    expect(fallbackTagFromName("Favorites")).toEqual([]);
    expect(fallbackTagFromName("favorite")).toEqual([]);
  });

  it("caps at 50 chars and re-trims any trailing dash the cut exposes", () => {
    const tag = fallbackTagFromName("x".repeat(60))[0]!;
    expect(tag.length).toBe(50);
    // 49 'a's + " b" → "aaa…-b"; slice(0,50) lands on the dash, which the
    // re-trim must strip so the tag never ends with '-'.
    const cut = fallbackTagFromName("a".repeat(49) + " b")[0]!;
    expect(cut).toBe("a".repeat(49));
    expect(cut.endsWith("-")).toBe(false);
  });
});

describe("templateTagsWithFallback", () => {
  it("prefers explicit tags over slug and name", () => {
    expect(templateTagsWithFallback(["x"], "Some Name", "some-slug")).toEqual([
      "x",
    ]);
  });

  it("falls back to the slug when there are no explicit tags", () => {
    expect(templateTagsWithFallback([], "Some Name", "some-slug")).toEqual([
      "some-slug",
    ]);
  });

  it("falls back to the name when there is neither tags nor slug", () => {
    expect(templateTagsWithFallback([], "Some Name", null)).toEqual([
      "some-name",
    ]);
    expect(templateTagsWithFallback([], "Some Name", undefined)).toEqual([
      "some-name",
    ]);
  });

  it("returns [] only when name yields nothing and there is no slug/tags", () => {
    expect(templateTagsWithFallback([], "✨", null)).toEqual([]);
  });
});
