import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * One workspace per (data_root, workgroup) (§6.7). Created on join and kept
 * across tasks, sessions and restarts; the directory is the agent's cwd, not a
 * per-task scratch space.
 */
export type Workspace = {
  root: string;
  /** Agent cwd and the only write root. */
  work: string;
  /** Cross-session notes; writable, never leaves this node. */
  notes: string;
  /** Task inputs pulled from blobs; owned by the gateway. */
  inputs: string;
  /** Gateway-owned metadata: index.json and per-task dirs. */
  pod: string;
  taskDir(taskId: string): string;
};

export type WorkspaceManager = {
  ensure(): Workspace;
  get(): Workspace;
};

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function createWorkspaceManager(options: {
  dataRoot: string;
  workgroupId: string;
}): WorkspaceManager {
  const root = join(options.dataRoot, "workgroups", options.workgroupId);
  const workspace: Workspace = {
    root,
    work: join(root, "work"),
    notes: join(root, "notes"),
    inputs: join(root, "inputs"),
    pod: join(root, ".pod"),
    taskDir(taskId: string): string {
      if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`invalid task id for workspace path: ${taskId}`);
      return join(root, ".pod", "tasks", taskId);
    },
  };

  let ensured = false;
  function ensure(): Workspace {
    if (!ensured) {
      for (const dir of [workspace.work, workspace.notes, workspace.inputs, join(workspace.pod, "tasks")]) {
        mkdirSync(dir, { recursive: true });
      }
      ensured = true;
    }
    return workspace;
  }

  return { ensure, get: ensure };
}
