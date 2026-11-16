import { mkdirSync, rmSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * One workspace per (data_root, workgroup) (§6.7). Created on join and kept
 * across tasks, sessions and restarts; its root is the agent's cwd, so project
 * files, `notes/` and a task's `inputs/<task_id>/` are all cwd-relative.
 *
 * Gateway-owned state (session maps, per-task session dirs) must NOT live in
 * the workspace: the agent may write anywhere under cwd. It lives under
 * `<data_root>/state/<workgroup_id>/` instead (§6.7).
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
  /** Materialization directory for one task's inputs; gateway-owned. */
  inputDir(taskId: string): string;
};

type WorkspaceManager = {
  /** Create the directories if needed and return the workspace. */
  ensure(): Workspace;
  /**
   * Remove materialized inputs left behind by a previous process. Called once
   * at startup: every task that owned them was failed by recovery (§8.3).
   */
  purgeInputs(): void;
};

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function createWorkspaceManager(options: { dataRoot: string; workgroupId: string }): WorkspaceManager {
  const root = join(options.dataRoot, "workgroups", options.workgroupId);
  const state = join(options.dataRoot, "state", options.workgroupId);
  const workspace: Workspace = {
    root,
    notes: join(root, "notes"),
    inputs: join(root, "inputs"),
    state,
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
    rmSync(workspace.inputs, { recursive: true, force: true });
    mkdirSync(workspace.inputs, { recursive: true });
  }

  return { ensure, purgeInputs };
}

export type WorkspaceUsage = { bytes: number; files: number };

/** `undefined` when the path vanished meanwhile (an agent may delete files under us); other errors surface. */
function ifMissing(error: NodeJS.ErrnoException): undefined {
  if (error.code === "ENOENT") return undefined;
  throw error;
}

/** Size and file count of everything under `root`, measured without blocking the event loop (§6.13). */
export async function measureWorkspace(root: string): Promise<WorkspaceUsage> {
  const entries = (await readdir(root, { withFileTypes: true, recursive: true }).catch(ifMissing)) ?? [];
  const usage = { bytes: 0, files: 0 };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stat = await lstat(join(entry.parentPath, entry.name)).catch(ifMissing);
    if (stat === undefined) continue;
    usage.bytes += stat.size;
    usage.files += 1;
  }
  return usage;
}
