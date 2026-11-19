import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Workspace } from "../src/task/workspace.ts";
import { wg } from "./fixtures/ids.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-workspace-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace", () => {
  it("names the group layout without creating it", () => {
    const workspace = new Workspace(tempDir(), wg("orca-dev"));
    expect(existsSync(workspace.root)).toBe(false);
    expect(workspace.root.endsWith(join("workgroups", "orca-dev"))).toBe(true);
    expect(workspace.state.endsWith(join("state", "orca-dev"))).toBe(true);
  });

  it("creates the group layout, and again without changing it", () => {
    const workspace = new Workspace(tempDir(), wg("orca-dev"));
    workspace.ensure();
    workspace.ensure();

    for (const dir of [workspace.root, workspace.state]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("isolates workgroups", () => {
    const dataRoot = tempDir();
    const first = new Workspace(dataRoot, wg("group-a"));
    const second = new Workspace(dataRoot, wg("group-b"));
    expect(first.root).not.toBe(second.root);
    expect(first.state).not.toBe(second.state);
  });
});
