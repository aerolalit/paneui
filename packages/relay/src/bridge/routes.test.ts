import { describe, it, expect } from "vitest";
import { loadClient } from "./routes.js";

describe("loadClient", () => {
  it("throws a clear error when the client bundle is missing", () => {
    expect(() => loadClient("does-not-exist.client.js")).toThrowError(
      /client bundle missing at .* — run `npm run build:client` first/,
    );
  });

  it("loads an existing client bundle", () => {
    expect(typeof loadClient("shim.client.js")).toBe("string");
  });
});
