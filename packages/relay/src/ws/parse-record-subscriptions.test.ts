// #295 — unit tests for the parseRecordSubscriptions helper. The full
// connect-replay flow is exercised via integration in existing ws/
// e2e tests; this file pins the URL-parsing rules in isolation.

import { describe, it, expect } from "vitest";
import { __recordSubsInternals } from "./handler.js";
import type { PaneWithTemplateVersion } from "../core/events.js";

// Minimal stub: only templateVersion.recordSchema matters for the parser.
function paneWith(recordSchema: unknown): PaneWithTemplateVersion {
  return {
    templateVersion: { recordSchema },
  } as unknown as PaneWithTemplateVersion;
}

const DECLARED = paneWith({
  $defs: {
    Comment: { type: "object" },
    Post: { type: "object" },
  },
  "x-pane-collections": {
    comments: {
      schema: { $ref: "#/$defs/Comment" },
      write: ["page"],
      delete: ["author"],
    },
    posts: {
      schema: { $ref: "#/$defs/Post" },
      write: ["agent"],
      delete: ["agent"],
    },
  },
});

const NO_RECORDS = paneWith(null);

function u(qs: string): URL {
  return new URL(`http://t/v1/panes/pan_x/stream${qs}`);
}

describe("parseRecordSubscriptions", () => {
  it("returns null when ?subscribe_records is absent", () => {
    expect(__recordSubsInternals.parse(u(""), DECLARED)).toBeNull();
  });

  it("subscribe_records=* expands to every declared collection", () => {
    const r = __recordSubsInternals.parse(u("?subscribe_records=*"), DECLARED);
    expect(r?.collections.sort()).toEqual(["comments", "posts"]);
  });

  it("subscribe_records=* on a pane with no record_schema yields an empty collection list", () => {
    const r = __recordSubsInternals.parse(
      u("?subscribe_records=*"),
      NO_RECORDS,
    );
    expect(r?.collections).toEqual([]);
  });

  it("subscribe_records=a,b filters to those collections", () => {
    const r = __recordSubsInternals.parse(
      u("?subscribe_records=comments"),
      DECLARED,
    );
    expect(r?.collections).toEqual(["comments"]);
  });

  it("subscribe_records with an unknown collection throws (400)", () => {
    expect(() =>
      __recordSubsInternals.parse(u("?subscribe_records=unknown"), DECLARED),
    ).toThrow(__recordSubsInternals.RecordSubscriptionError);
  });

  it("since_record_seq.<name> parses per-collection cursors", () => {
    const r = __recordSubsInternals.parse(
      u(
        "?subscribe_records=comments,posts&since_record_seq.comments=5&since_record_seq.posts=12",
      ),
      DECLARED,
    );
    expect(r?.sinceByCollection.get("comments")).toBe(5);
    expect(r?.sinceByCollection.get("posts")).toBe(12);
  });

  it("since_record_seq for a non-subscribed collection throws", () => {
    expect(() =>
      __recordSubsInternals.parse(
        u("?subscribe_records=comments&since_record_seq.posts=5"),
        DECLARED,
      ),
    ).toThrow(__recordSubsInternals.RecordSubscriptionError);
  });

  it("since_record_seq with a non-integer value throws", () => {
    expect(() =>
      __recordSubsInternals.parse(
        u("?subscribe_records=comments&since_record_seq.comments=abc"),
        DECLARED,
      ),
    ).toThrow(__recordSubsInternals.RecordSubscriptionError);
  });

  it("since_record_seq with a negative value throws", () => {
    expect(() =>
      __recordSubsInternals.parse(
        u("?subscribe_records=comments&since_record_seq.comments=-1"),
        DECLARED,
      ),
    ).toThrow(__recordSubsInternals.RecordSubscriptionError);
  });

  it("collections default to empty cursors when since_record_seq is omitted", () => {
    const r = __recordSubsInternals.parse(
      u("?subscribe_records=comments"),
      DECLARED,
    );
    expect(r?.sinceByCollection.size).toBe(0);
  });
});
