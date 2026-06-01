import { describe, it, expect } from "vitest";
import { paneInitials, paneHue, formatRelativeDate } from "./system-pages.js";

describe("paneInitials", () => {
  it("returns the first letter of two words upper-cased", () => {
    expect(paneInitials("PR Review")).toBe("PR");
    expect(paneInitials("deploy approval")).toBe("DA");
  });

  it("returns the first two letters of a single word", () => {
    expect(paneInitials("approve")).toBe("AP");
    expect(paneInitials("X")).toBe("X");
  });

  it("treats common separators as word breaks", () => {
    expect(paneInitials("pr-review")).toBe("PR");
    expect(paneInitials("pr_review")).toBe("PR");
    expect(paneInitials("pr.review.v2")).toBe("PR");
    expect(paneInitials("pr/review")).toBe("PR");
  });

  it("falls back to '?' for empty / whitespace input", () => {
    expect(paneInitials("")).toBe("?");
    expect(paneInitials("   ")).toBe("?");
  });

  it("uses the leading two characters when nothing is alphanumeric", () => {
    expect(paneInitials("@#")).toBe("@#");
  });
});

describe("paneHue", () => {
  it("returns a hue in [0, 360)", () => {
    for (const seed of ["pan_a", "pan_b", "pan_abc123", "literally anything"]) {
      const h = paneHue(seed);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("is deterministic for a given seed", () => {
    expect(paneHue("pan_xyz")).toBe(paneHue("pan_xyz"));
  });

  it("yields different hues for visually distinct seeds (probabilistic)", () => {
    // Not a guarantee for any specific pair, but across a handful of
    // pane ids we should see at least two distinct values.
    const hues = new Set(
      ["pan_a", "pan_b", "pan_c", "pan_d", "pan_e"].map(paneHue),
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
