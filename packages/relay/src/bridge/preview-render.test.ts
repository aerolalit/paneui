import { describe, it, expect } from "vitest";
import { wrapArtifactForPreview } from "./preview-render.js";

// Pull the inert `window.pane` shim (the first inline <script> in a preview
// document) out of the generated HTML and execute it against a fake window, so
// we can assert the live-runtime API surface is mirrored. The shim is an IIFE
// that assigns `window.pane`.
function evalShim(html: string): Record<string, unknown> {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no shim <script> found in preview HTML");
  const win = {} as { pane?: Record<string, unknown> };
  new Function("window", m[1])(win);
  if (!win.pane) throw new Error("shim did not assign window.pane");
  return win.pane;
}

describe("preview pane shim", () => {
  // Regression for the home/explore preview crash: records-backed pages (todo
  // lists, kanban, …) called pane.records.snapshot()/on() and
  // pane.template.records.on(), which threw "Cannot read properties of
  // undefined" because the preview shim never mirrored those namespaces. dev
  // looked fine only because its test panes didn't use records.
  it("mirrors pane.records + pane.template.records so records pages don't throw", () => {
    const pane = evalShim(
      wrapArtifactForPreview("<div></div>", { a: 1 }),
    ) as any;

    // pane-level records: reads are empty, subscribe is a no-op unsubscribe,
    // writes are present (resolve inertly).
    expect(typeof pane.records.snapshot).toBe("function");
    expect(pane.records.snapshot("todos")).toEqual([]);
    expect(typeof pane.records.on("todos", () => {})).toBe("function");
    for (const m of ["create", "upsert", "update", "delete"]) {
      expect(typeof pane.records[m]).toBe("function");
    }

    // template-level records: read-only mirror.
    expect(pane.template.records.snapshot("catalog")).toEqual([]);
    expect(typeof pane.template.records.on("catalog", () => {})).toBe(
      "function",
    );

    // existing surface still intact.
    expect(pane.inputData).toEqual({ a: 1 });
    expect(typeof pane.on).toBe("function");
    expect(typeof pane.emit).toBe("function");
  });

  it("records write stubs resolve without hitting the network", async () => {
    const pane = evalShim(wrapArtifactForPreview("<div></div>", null)) as any;
    await expect(pane.records.create("c", {})).resolves.toBeNull();
    await expect(pane.records.delete("c", "k")).resolves.toBeUndefined();
  });
});
