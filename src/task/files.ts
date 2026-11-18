import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { blobRefText, saveBlob, type FetchBlob, type FileBlobRegistry } from "../core/blobs.ts";
import { MAX_TASK_FILES } from "../core/constants.ts";
import { errorMessage, isMissingFile, PodError } from "../core/errors.ts";
import type { TaskMeta } from "./meta.ts";
import type { TaskView } from "./wire.ts";
import type { Workspace } from "./workspace.ts";

type TaskArtifact = NonNullable<TaskView["artifacts"]>[number];

/**
 * The files of one task (§3.8). An ACP agent runs in another `dsh` process and
 * cannot see this plugin's tools, so the node hands files over for it: what the
 * origin attached is fetched into `inbox/<task_id>/` before the agent starts,
 * and what the agent leaves in `outbox/<task_id>/` is published when the task
 * ends. The agent only reads and writes ordinary directories.
 */
export class TaskFiles {
  constructor(
    private readonly taskId: string,
    private readonly inputs: TaskMeta["files"],
    private readonly workspace: Workspace,
    /** Where the files this node hands back are published (§5.6). */
    private readonly blobs: FileBlobRegistry,
    private readonly fetchBlob: FetchBlob,
    /** The largest single file taken in or handed back. */
    private readonly maxBytes: number,
  ) {}

  /**
   * Fetch every attached file into the inbox and return their workspace-relative
   * paths. A file that cannot be had ends the task: the agent is not left to
   * retry on its own.
   */
  async stage(signal: AbortSignal): Promise<string[]> {
    if (this.inputs.length === 0) return [];
    const dir = this.workspace.inbox(this.taskId);
    await mkdir(dir, { recursive: true });
    for (const { ref, name } of this.inputs) {
      try {
        await saveBlob(await this.fetchBlob(ref, signal), join(dir, name), ref.blob, this.maxBytes);
      } catch (error) {
        throw new PodError(
          "input_unavailable",
          `input file ${name} (${blobRefText(ref)}) could not be fetched: ${errorMessage(error)}`,
        );
      }
    }
    return this.inputs.map(({ name }) => `inbox/${this.taskId}/${name}`);
  }

  /**
   * Publish the regular files at the top of the outbox. Each is copied out of
   * the agent's reach before it is named by its hash, so a later write by the
   * agent cannot change what a fetcher gets. What is not handed back (over the
   * limits, or a failure) is reported in `note`; the task still ends as it did.
   */
  async publish(firstIndex: number): Promise<{ artifacts: TaskArtifact[]; note: string | null }> {
    const dir = this.workspace.outbox(this.taskId);
    let names: string[];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      names = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isMissingFile(error)) return { artifacts: [], note: null };
      return { artifacts: [], note: `outbox could not be read: ${errorMessage(error)}` };
    }
    const artifacts: TaskArtifact[] = [];
    const skipped: string[] = [];
    for (const name of names) {
      if (artifacts.length >= MAX_TASK_FILES) {
        skipped.push(`${name} (more than ${MAX_TASK_FILES} files)`);
        continue;
      }
      try {
        const source = join(dir, name);
        if ((await stat(source)).size > this.maxBytes) {
          skipped.push(`${name} (larger than ${this.maxBytes} bytes)`);
          continue;
        }
        const copy = this.workspace.artifactPath(this.taskId, firstIndex + artifacts.length);
        await mkdir(dirname(copy), { recursive: true });
        await copyFile(source, copy);
        const blob = await this.blobs.register(copy);
        artifacts.push({ artifactId: blob.blob_id, name, bytes: blob.size });
      } catch (error) {
        skipped.push(`${name} (${errorMessage(error)})`);
      }
    }
    return {
      artifacts,
      note: skipped.length === 0 ? null : `outbox files that were not handed back: ${skipped.join(", ")}`,
    };
  }

  /** The task is over: nothing of it stays in the shared workspace (the published copies live under this node's state). */
  async clear(): Promise<void> {
    await Promise.all([
      rm(this.workspace.inbox(this.taskId), { recursive: true, force: true }),
      rm(this.workspace.outbox(this.taskId), { recursive: true, force: true }),
    ]);
  }
}
