import { mkdirSync, readdirSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkgroupId } from "../core/wire/peer.ts";
import { isMissingFile } from "../core/errors.ts";

export type WorkspaceUsage = { bytes: number; files: number };

/** `undefined` when the path vanished meanwhile (an agent may delete files under us); other errors surface. */
function ifMissing(error: unknown): undefined {
  if (isMissingFile(error)) return undefined;
  throw error;
}

/**
 * One workspace per (data_root, workgroup) (§6.7). Created when the node starts and kept
 * across tasks, sessions and restarts; its root is the agent's cwd, so project
 * files and `notes/` are cwd-relative.
 *
 * Gateway-owned state (session maps, per-task session dirs) must NOT live in
 * the workspace: the agent may write anywhere under cwd. It lives under
 * `<data_root>/state/<workgroup_id>/` instead (§6.7).
 */
export class Workspace {
  /** Agent cwd and the only write root for the group. */
  readonly root: string;
  /** Cross-session notes; writable, never leaves this orcaNode. */
  readonly notes: string;
  /** Gateway-owned state outside the agent's reach. */
  readonly state: string;

  /** Only names the directories; `ensure()` creates them. */
  constructor(dataRoot: string, workgroupId: WorkgroupId) {
    this.root = join(dataRoot, "workgroups", workgroupId);
    this.notes = join(this.root, "notes");
    this.state = join(dataRoot, "state", workgroupId);
  }

  /** Create the workspace directories if they are missing; running it twice changes nothing. */
  ensure(): void {
    for (const dir of [this.root, this.notes, join(this.state, "tasks")]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Size and file count of everything under the root, measured without blocking the event loop (§6.13). */
  async measure(): Promise<WorkspaceUsage> {
    const entries = (await readdir(this.root, { withFileTypes: true, recursive: true }).catch(ifMissing)) ?? [];
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

  /** Names of the regular files at the top of `notes/`, sorted; none when the directory does not exist yet. */
  noteFiles(): string[] {
    try {
      return readdirSync(this.notes, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  /** Where the files the origin attached to a task are placed before the agent starts (§3.8); inside the cwd, so the agent can read them. */
  inbox(taskId: string): string {
    return join(this.root, "inbox", taskId);
  }

  /** Where the agent leaves the files to hand back; this node publishes them when the task ends (§3.8). */
  outbox(taskId: string): string {
    return join(this.root, "outbox", taskId);
  }

  /** Where the `index`-th (from 1) artifact of a task is kept: under the node's own state, outside the agent's reach. */
  artifactPath(taskId: string, index: number): string {
    return join(this.state, "artifacts", taskId, String(index));
  }
}
