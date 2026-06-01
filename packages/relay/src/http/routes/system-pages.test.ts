import { describe, it, expect } from "vitest";
import {
  surfaceInitials,
  surfaceHue,
  formatRelativeDate,
} from "./system-pages.js";

describe("surfaceInitials", () => {
  it("returns the first letter of two words upper-cased", () => {
    expect(surfaceInitials("PR Review")).toBe("PR");
    expect(surfaceInitials("deploy approval")).toBe("DA");
  });

  it("returns the first two letters of a single word", () => {
    expect(surfaceInitials("approve")).toBe("AP");
    expect(surfaceInitials("X")).toBe("X");
  });

  it("treats common separators as word breaks", () => {
    expect(surfaceInitials("pr-review")).toBe("PR");
    expect(surfaceInitials("pr_review")).toBe("PR");
    expect(surfaceInitials("pr.review.v2")).toBe("PR");
    expect(surfaceInitials("pr/review")).toBe("PR");
  });

  it("falls back to '?' for empty / whitespace input", () => {
    expect(surfaceInitials("")).toBe("?");
    expect(surfaceInitials("   ")).toBe("?");
  });

  it("uses the leading two characters when nothing is alphanumeric", () => {
    expect(surfaceInitials("@#")).toBe("@#");
  });
});

describe("surfaceHue", () => {
  it("returns a hue in [0, 360)", () => {
    for (const seed of ["sur_a", "sur_b", "sur_abc123", "literally anything"]) {
      const h = surfaceHue(seed);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("is deterministic for a given seed", () => {
    expect(surfaceHue("sur_xyz")).toBe(surfaceHue("sur_xyz"));
  });

  it("yields different hues for visually distinct seeds (probabilistic)", () => {
    // Not a guarantee for any specific pair, but across a handful of
    // surface ids we should see at least two distinct values.
    const hues = new Set(
      ["sur_a", "sur_b", "sur_c", "sur_d", "sur_e"].map(surfaceHue),
    );
    expect(hues.size).toBeGreaterThanOrEqual(2);
  });
});

describe("formatRelativeDate", () => {
  // Local-time constructors so the test is timezone-agnostic: the function
  // uses local-time .getFullYear/.getMonth/.getDate (it's a human-facing
  // label and "today" should mean today in the reader's locale).
  const now = new Date(2026, 5, 1, 12, 0, 0); // 2026-06-01 12:00 local

  it("renders 'today' for same local calendar day", () => {
    expect(formatRelativeDate(new Date(2026, 5, 1, 8, 0, 0), now)).toBe(
      "today",
    );
  });

  it("renders 'yesterday' for the previous local calendar day", () => {
    expect(formatRelativeDate(new Date(2026, 4, 31, 23, 0, 0), now)).toBe(
      "yesterday",
    );
  });

  it("renders 'Nd ago' for 2 to 13 days back", () => {
    expect(formatRelativeDate(new Date(2026, 4, 29, 12, 0, 0), now)).toBe(
      "3d ago",
    );
    expect(formatRelativeDate(new Date(2026, 4, 19, 12, 0, 0), now)).toBe(
      "13d ago",
    );
  });

  it("falls back to ISO date once the gap reaches 14 days", () => {
    expect(formatRelativeDate(new Date(2026, 4, 18, 12, 0, 0), now)).toBe(
      "2026-05-18",
    );
  });
});
