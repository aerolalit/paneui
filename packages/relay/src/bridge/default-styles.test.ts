import { describe, it, expect } from "vitest";
import {
  PANE_DEFAULT_CSS,
  shouldInjectDefaults,
  BARE_MARKER,
} from "./default-styles.js";

describe("PANE_DEFAULT_CSS", () => {
  it("is a non-empty CSS string", () => {
    expect(typeof PANE_DEFAULT_CSS).toBe("string");
    expect(PANE_DEFAULT_CSS.length).toBeGreaterThan(100);
  });

  it("declares the design tokens it advertises", () => {
    for (const token of [
      "--pane-bg",
      "--pane-fg",
      "--pane-accent",
      "--pane-border",
      "--pane-radius",
      "--pane-font",
    ]) {
      expect(PANE_DEFAULT_CSS).toContain(token);
    }
  });

  it("includes a prefers-color-scheme: dark block", () => {
    expect(PANE_DEFAULT_CSS).toContain("prefers-color-scheme: dark");
  });
});

describe("shouldInjectDefaults / BARE_MARKER", () => {
  it("injects for a normal artifact body", () => {
    expect(
      shouldInjectDefaults("<html><body><form>x</form></body></html>"),
    ).toBe(true);
  });

  it("opts out when the bare marker is on <html>", () => {
    expect(
      shouldInjectDefaults("<html data-pane-bare><body>raw</body></html>"),
    ).toBe(false);
  });

  it("opts out when the bare marker is on <body>", () => {
    expect(
      shouldInjectDefaults("<html><body data-pane-bare>raw</body></html>"),
    ).toBe(false);
  });

  it("opts out even when the marker appears in a comment (acceptable false positive)", () => {
    // Documented behaviour: the literal scan is intentionally simple. A
    // comment containing `data-pane-bare` opts out; the marker is unusual
    // enough that this isn't a real-world hazard, and a structural HTML
    // parse on every request would cost more than it's worth.
    expect(shouldInjectDefaults("<!-- data-pane-bare -->raw")).toBe(false);
  });

  it("exposes the marker string as a constant so callers can document it", () => {
    expect(BARE_MARKER).toBe("data-pane-bare");
  });
});
