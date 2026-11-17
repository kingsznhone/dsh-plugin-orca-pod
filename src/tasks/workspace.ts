import { mkdirSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkgroupId } from "../protocol/peer.ts";
import { isMissingFile } from "../kernel/errors.ts";

/**
 * One workspace per (data_root, workgroup) (§6.7). Created on join and kept
 * across tasks, sessions and restarts; its root is the agent's cwd, so project
 * files and `notes/` are cwd-relative.
 *
 * Gateway-owned state (session maps, per-task session dirs) must NOT live in
 * the workspace: the agent may write anywhere under cwd. It lives under
 * `<data_root>/state/<workgroup_id>/` instead (§6.7).
 */
export type WorkspacePaths = {
  /** Agent cwd and the only write root for the group. */
  root: string;
  /** Cross-session notes; writable, never leaves this orcaNode. */
  notes: string;
  /** Gateway-owned state outside the agent's reach. */
  state: string;
};

type WorkspaceManager = {
  /** Create the directories if needed and return the workspace. */
  ensure(): WorkspacePaths;
};

export function createWorkspaceManager(options: { dataRoot: string; workgroupId: WorkgroupId }): WorkspaceManager {
  const root = join(options.dataRoot, "workgroups", options.workgroupId);
  const state = join(options.dataRoot, "state", options.workgroupId);
  const workspace: WorkspacePaths = {
    root,
    notes: join(root, "notes"),
    state,
  };

  let ensured = false;
  function ensure(): WorkspacePaths {
    if (!ensured) {
      for (const dir of [workspace.root, workspace.notes, join(workspace.state, "tasks")]) {
        mkdirSync(dir, { recursive: true });
      }
      ensured = true;
    }
    return workspace;
  }

  return { ensure };
}

export type WorkspaceUsage = { bytes: number; files: number };

/** `undefined` when the path vanished meanwhile (an agent may delete files under us); other errors surface. */
function ifMissing(error: unknown): undefined {
  if (isMissingFile(error)) return undefined;
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
