// Unit tests for the pure helpers in `pane watch` — the CSV parser for
// --type / --filter-type, and the output-filter predicate that decides
// whether a given event reaches stdout.
//
// The full runWatch flow is hard to test in isolation (WS lifecycle +
// openStream + timers), but the two behaviours that #137 highlighted —
// any-of exit conditions and output filtering — live in pure helpers
// that pin the contract here.

import { describe, it, expect } from "vitest";
import { parseTypeList, shouldPrintEvent } from "./watch.js";

describe("parseTypeList", () => {
  it("returns null when the flag wasn't given", () => {
    // Distinct from a Set with zero entries — callers branch on null to
    // mean "no filter at all" vs "filter, but empty".
    expect(parseTypeList(undefined)).toBeNull();
  });

  it("parses a single type", () => {
    const out = parseTypeList("form.submitted");
    expect(out).toEqual(new Set(["form.submitted"]));
  });

  it("parses a comma-separated list (any-of)", () => {
    const out = parseTypeList("form.submitted,form.cancelled,form.draft");
    expect(out).toEqual(
      new Set(["form.submitted", "form.cancelled", "form.draft"]),
    );
  });

  it("trims whitespace around each entry", () => {
    // Common shell mistake: 'pane watch --type "a, b ,c"' — the inner
    // spaces are easy to type and shouldn't poison the lookup.
    const out = parseTypeList("a , b ,c");
    expect(out).toEqual(new Set(["a", "b", "c"]));
  });

  it("drops empty entries from doubled commas / trailing commas", () => {
    // Same lenience as --tags; an empty type can never match a real
    // event, so silently dropping it is the cleanest behaviour.
    const out = parseTypeList("a,,b,");
    expect(out).toEqual(new Set(["a", "b"]));
  });

  it("returns an empty Set for an all-whitespace value", () => {
    // Empty Set != null. The caller will then short-circuit nothing on
    // exit and print nothing on filter — but that's a user-visible
    // mistake, not a parser bug; we don't try to guess intent here.
    const out = parseTypeList("   ");
    expect(out).toEqual(new Set());
  });
});

describe("shouldPrintEvent", () => {
  it("returns true for every event when no filter is set (null)", () => {
    expect(shouldPrintEvent("form.submitted", null)).toBe(true);
    expect(shouldPrintEvent("system.participant.joined", null)).toBe(true);
    expect(shouldPrintEvent("anything.at.all", null)).toBe(true);
  });

  it("prints events whose type is in the filter set", () => {
    const filter = new Set(["form.submitted", "form.cancelled"]);
    expect(shouldPrintEvent("form.submitted", filter)).toBe(true);
    expect(shouldPrintEvent("form.cancelled", filter)).toBe(true);
  });

  it("drops events whose type is NOT in the filter set", () => {
    const filter = new Set(["form.submitted"]);
    expect(shouldPrintEvent("form.draft", filter)).toBe(false);
    expect(shouldPrintEvent("unrelated.event", filter)).toBe(false);
  });

  it("always passes system.* lifecycle events through, even with a filter", () => {
    // The load-bearing invariant: an agent that runs
    //   pane watch --filter-type form.submitted
    // must still see system.participant.joined (the "human opened the
    // URL" signal) and system.session.expired (the "give up" signal).
    // Without this carve-out the agent's harness would lose visibility
    // into the session lifecycle the moment a filter was set.
    const filter = new Set(["form.submitted"]);
    expect(shouldPrintEvent("system.participant.joined", filter)).toBe(true);
    expect(shouldPrintEvent("system.session.expired", filter)).toBe(true);
    expect(shouldPrintEvent("system.anything.future", filter)).toBe(true);
  });

  it("an EMPTY filter set drops everything except system.*", () => {
    // Edge case: --filter-type was passed with no real types (or all
    // empty entries got dropped by the parser). User-visible footgun,
    // but the behaviour is consistent: filter as instructed, lifecycle
    // events still pass.
    const filter = new Set<string>();
    expect(shouldPrintEvent("form.submitted", filter)).toBe(false);
    expect(shouldPrintEvent("system.participant.joined", filter)).toBe(true);
  });
});
