/** Durable and in-memory task stores (§5.5). */

import { jsonTable, openDb } from "../core/sqlite.ts";
import type { OrcaNodeId } from "../core/wire/peer.ts";
import type { TaskView } from "./wire.ts";

// Tasks (§5.5)

/**
 * Durable task record (§5.5). The view is the A2A `TaskView` the gateway
 * serves; the extra fields belong to the local store only.
 */
export type PersistedTask = {
  view: TaskView;
  origin_orca_node: OrcaNodeId;
  created_at: string;
  updated_at: string;
};

/**
 * Task store contract. One process writes it, one process reads it (§5.5):
 * no pooling, no service, no shared database.
 */
export interface TaskStore {
  save(task: PersistedTask): void;
  load(taskId: string): PersistedTask | undefined;
  list(): PersistedTask[];
  /** Durable stores release their handle; memory stores have nothing to close. */
  close(): void;
}

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

/** Durable task store (§5.5). */
export function createSqliteTaskStore(path: string): TaskStore {
  const handle = openDb(path);
  const table = jsonTable<PersistedTask>(
    handle,
    "tasks",
    (task) => task.view.id,
    (task) => task.updated_at,
  );
  return { save: table.save, load: table.get, list: table.list, close: handle.close };
}
