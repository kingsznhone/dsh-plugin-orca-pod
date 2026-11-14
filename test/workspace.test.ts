import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceManager } from "../src/workspace.ts";

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
    const manager = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: "orca-dev" });
    const workspace = manager.ensure();

    for (const dir of [workspace.root, workspace.notes, workspace.inputs, workspace.state]) {
      expect(existsSync(dir)).toBe(true);
    }
    expect(existsSync(join(workspace.state, "tasks"))).toBe(true);
    expect(workspace.root.endsWith(join("workgroups", "orca-dev"))).toBe(true);
    expect(workspace.state.endsWith(join("state", "orca-dev"))).toBe(true);
  });

  it("is idempotent and stable across calls", () => {
    const manager = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: "orca-dev" });
    expect(manager.ensure().root).toBe(manager.get().root);
  });

  it("isolates workgroups", () => {
    const dataRoot = tempDir();
    const first = createWorkspaceManager({ dataRoot, workgroupId: "group-a" });
    const second = createWorkspaceManager({ dataRoot, workgroupId: "group-b" });
    expect(first.ensure().root).not.toBe(second.ensure().root);
  });

  it("builds per-task dirs under the state dir and rejects traversal", () => {
    const workspace = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: "orca-dev" }).get();
    expect(workspace.taskDir("TASK01")).toBe(join(workspace.state, "tasks", "TASK01"));
    expect(workspace.inputDir("TASK01")).toBe(join(workspace.root, "inputs", "TASK01"));
    expect(() => workspace.taskDir("../escape")).toThrow();
    expect(() => workspace.taskDir("a/b")).toThrow();
    expect(() => workspace.inputDir("../escape")).toThrow();
  });

  it("purges leftover input dirs on startup", () => {
    const manager = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: "orca-dev" });
    const workspace = manager.ensure();
    writeFileSync(join(workspace.inputs, "stale"), "x");
    manager.purgeInputs();
    expect(existsSync(workspace.inputs)).toBe(true);
    expect(existsSync(join(workspace.inputs, "stale"))).toBe(false);
  });
});
