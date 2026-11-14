import { mkdirSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * One workspace per (data_root, workgroup) (§6.7). Created on join and kept
 * across tasks, sessions and restarts; its root is the agent's cwd, so project
 * files, `notes/` and a task's `inputs/<task_id>/` are all cwd-relative.
 *
 * Gateway-owned state (session maps, per-task session dirs) must NOT live in
 * the workspace: the agent may write anywhere under cwd. It lives under
 * `<data_root>/state/<workgroup_id>/` instead (§6.7, §18).
 */
export type Workspace = {
  /** Agent cwd and the only write root for the group. */
  root: string;
  /** Cross-session notes; writable, never leaves this orcaNode. */
  notes: string;
  /** Task inputs pulled from blobs, one directory per task; gateway-owned. */
  inputs: string;
  /** Gateway-owned state outside the agent's reach. */
  state: string;
  /** Per-task session/artifact dirs under `state`. */
  taskDir(taskId: string): string;
  /** Materialization directory for one task's inputs; gateway-owned. */
  inputDir(taskId: string): string;
};

export type WorkspaceManager = {
  ensure(): Workspace;
  get(): Workspace;
  /**
   * Remove materialized inputs left behind by a previous process. Called once
   * at startup: every task that owned them was failed by recovery (§8.4).
   */
  purgeInputs(): void;
};

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function createWorkspaceManager(options: {
  dataRoot: string;
  workgroupId: string;
}): WorkspaceManager {
  const root = join(options.dataRoot, "workgroups", options.workgroupId);
  const state = join(options.dataRoot, "state", options.workgroupId);
  const workspace: Workspace = {
    root,
    notes: join(root, "notes"),
    inputs: join(root, "inputs"),
    state,
    taskDir(taskId: string): string {
      if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`invalid task id for workspace path: ${taskId}`);
      return join(state, "tasks", taskId);
    },
    inputDir(taskId: string): string {
      if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`invalid task id for workspace path: ${taskId}`);
      return join(root, "inputs", taskId);
    },
  };

  let ensured = false;
  function ensure(): Workspace {
    if (!ensured) {
      for (const dir of [workspace.root, workspace.notes, workspace.inputs, join(workspace.state, "tasks")]) {
        mkdirSync(dir, { recursive: true });
      }
      ensured = true;
    }
    return workspace;
  }

  function purgeInputs(): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(workspace.inputs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      rmSync(join(workspace.inputs, entry.name), { recursive: true, force: true });
    }
  }

  return { ensure, get: ensure, purgeInputs };
}
