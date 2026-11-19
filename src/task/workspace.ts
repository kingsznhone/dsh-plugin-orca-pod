import { mkdirSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkgroupId } from "../core/ids.ts";
import { isMissingFile } from "../core/errors.ts";

/**
 * One workspace per (data_root, workgroup) (§6.7). Created when the node starts and kept
 * across tasks, sessions and restarts; its root is the agent's cwd. What the
 * agent keeps there, notes included, is the agent's own business.
 *
 * Gateway-owned state (session maps, per-task session dirs) must NOT live in
 * the workspace: the agent may write anywhere under cwd. It lives under
 * `<data_root>/state/<workgroup_id>/` instead (§6.7).
 */
export class Workspace {
  /** Agent cwd and the only write root for the group. */
  readonly root: string;
  /** Gateway-owned state outside the agent's reach. */
  readonly state: string;

  /** Only names the directories; `ensure()` creates them. */
  constructor(dataRoot: string, workgroupId: WorkgroupId) {
    this.root = join(dataRoot, "workgroups", workgroupId);
    this.state = join(dataRoot, "state", workgroupId);
  }

  /** Create the workspace directories if they are missing; running it twice changes nothing. */
  ensure(): void {
    for (const dir of [this.root, this.state]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Bytes of everything under the root, measured without blocking the event loop (§6.13). */
  async measure(): Promise<number> {
    // A path that vanished meanwhile (an agent may delete files under us) counts as nothing; other errors surface.
    const entries = await readdir(this.root, { withFileTypes: true, recursive: true }).catch((error: unknown) => {
      if (isMissingFile(error)) return [];
      throw error;
    });
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await lstat(join(entry.parentPath, entry.name)).catch((error: unknown) => {
        if (isMissingFile(error)) return undefined;
        throw error;
      });
      if (stat === undefined) continue;
      bytes += stat.size;
    }
    return bytes;
  }
}
