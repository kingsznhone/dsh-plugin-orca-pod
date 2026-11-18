import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceManager } from "../src/task/workspace.ts";
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

describe("workspace manager", () => {
  it("creates the group layout once", () => {
    const manager = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: wg("orca-dev") });
    const workspace = manager.ensure();

    for (const dir of [workspace.root, workspace.notes, workspace.state]) {
      expect(existsSync(dir)).toBe(true);
    }
    expect(existsSync(join(workspace.state, "tasks"))).toBe(true);
    expect(workspace.root.endsWith(join("workgroups", "orca-dev"))).toBe(true);
    expect(workspace.state.endsWith(join("state", "orca-dev"))).toBe(true);
  });

  it("is idempotent and stable across calls", () => {
    const manager = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: wg("orca-dev") });
    expect(manager.ensure()).toBe(manager.ensure());
  });

  it("isolates workgroups", () => {
    const dataRoot = tempDir();
    const first = createWorkspaceManager({ dataRoot, workgroupId: wg("group-a") });
    const second = createWorkspaceManager({ dataRoot, workgroupId: wg("group-b") });
    expect(first.ensure().root).not.toBe(second.ensure().root);
  });
});
