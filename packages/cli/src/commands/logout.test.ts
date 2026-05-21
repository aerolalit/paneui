// Tests for `pane agent logout` — clears the saved config, idempotently.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogout } from "./logout.js";
import { writeStore, storePath } from "../store.js";

let dir: string;
let savedXdg: string | undefined;
let stdout: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pane-logout-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += s;
    return true;
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  vi.restoreAllMocks();
});

describe("runLogout", () => {
  it("deletes the saved config and reports the path", async () => {
    writeStore({ url: "https://relay.test", apiKey: "pk_secret" });
    expect(existsSync(storePath())).toBe(true);

    await runLogout();

    expect(existsSync(storePath())).toBe(false);
    expect(JSON.parse(stdout)).toEqual({ cleared: true, path: storePath() });
  });

  it("is idempotent when no config file exists", async () => {
    expect(existsSync(storePath())).toBe(false);
    await runLogout();
    expect(JSON.parse(stdout)).toEqual({ cleared: true, path: storePath() });
  });
});
