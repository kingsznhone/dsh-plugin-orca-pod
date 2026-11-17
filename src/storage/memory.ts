/** In-memory stores: unit tests, harness nodes and any node created without persistent storage. */

import type { DispatchEntry } from "../protocol/dispatch.ts";
import type { DispatchStore, FileBlob, FileBlobStore, PersistedTask, TaskStore } from "./stores.ts";

function cloneTask(task: PersistedTask): PersistedTask {
  return structuredClone(task);
}

/** Protocol tests and harness orca nodes use this; the CLI/plugin wire SQLite. */
export function createMemoryTaskStore(initial: readonly PersistedTask[] = []): TaskStore {
  const tasks = new Map<string, PersistedTask>();
  for (const task of initial) tasks.set(task.view.id, cloneTask(task));
  return {
    save(task: PersistedTask): void {
      tasks.set(task.view.id, cloneTask(task));
    },
    load(taskId: string): PersistedTask | undefined {
      const task = tasks.get(taskId);
      return task ? cloneTask(task) : undefined;
    },
    list(): PersistedTask[] {
      return [...tasks.values()].map(cloneTask).sort((left, right) => left.updated_at.localeCompare(right.updated_at));
    },
    close() {},
  };
}

/** A mapping that lives as long as the process: unit tests and in-memory orca nodes. */
export function createMemoryFileBlobStore(): FileBlobStore {
  const entries = new Map<string, FileBlob>();
  return {
    save(blob) {
      entries.set(blob.blob_id, blob);
    },
    get: (blobId) => entries.get(blobId),
    close() {},
  };
}

export function createMemoryDispatchStore(): DispatchStore {
  const entries = new Map<string, DispatchEntry>();
  return {
    save(entry) {
      entries.set(entry.task_id, entry);
    },
    get: (taskId) => entries.get(taskId),
    list: () => [...entries.values()].sort((left, right) => left.created_at.localeCompare(right.created_at)),
    remove(taskId) {
      entries.delete(taskId);
    },
    close() {},
  };
}
