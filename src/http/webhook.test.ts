import { describe, it, expect } from "vitest";
import { shouldFire } from "./webhook.js";

describe("shouldFire (glob)", () => {
  it("exact literal match", () => {
    expect(shouldFire("review.commentAdded", ["review.commentAdded"])).toBe(true);
    expect(shouldFire("review.approved", ["review.commentAdded"])).toBe(false);
  });

  it("prefix wildcard", () => {
    expect(shouldFire("review.commentAdded", ["review.*"])).toBe(true);
    expect(shouldFire("review.approved", ["review.*"])).toBe(true);
    expect(shouldFire("form.submitted", ["review.*"])).toBe(false);
  });

  it("multiple patterns: any matches", () => {
    const filter = ["review.*", "form.submitted"];
    expect(shouldFire("review.commentAdded", filter)).toBe(true);
    expect(shouldFire("form.submitted", filter)).toBe(true);
    expect(shouldFire("highlight.requested", filter)).toBe(false);
  });

  it("empty / nullish filter never matches", () => {
    expect(shouldFire("review.commentAdded", [])).toBe(false);
    expect(shouldFire("review.commentAdded", null)).toBe(false);
    expect(shouldFire("review.commentAdded", undefined)).toBe(false);
  });

  it("escapes regex specials in literal parts", () => {
    expect(shouldFire("a.b", ["a.b"])).toBe(true);
    // Without escaping, "a.b" pattern as regex would also match "aXb".
    expect(shouldFire("aXb", ["a.b"])).toBe(false);
  });
});
