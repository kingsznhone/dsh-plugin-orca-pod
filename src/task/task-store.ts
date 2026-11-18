/** Durable and in-memory task stores (§5.5). */

import { JsonTable, type SqliteDb } from "../core/sqlite.ts";
import type { OrcaNodeId } from "../core/wire/peer.ts";
import type { TaskView } from "./wire.ts";

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
}

/** Protocol tests and harness orca nodes use this; the CLI/plugin wire SQLite. */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, PersistedTask>();

  constructor(initial: readonly PersistedTask[] = []) {
    for (const task of initial) this.tasks.set(task.view.id, structuredClone(task));
  }

  save(task: PersistedTask): void {
    this.tasks.set(task.view.id, structuredClone(task));
  }

  load(taskId: string): PersistedTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  list(): PersistedTask[] {
    return [...this.tasks.values()]
      .map((task) => structuredClone(task))
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at));
  }
}

/** Durable task store (§5.5). */
export class SqliteTaskStore implements TaskStore {
  private readonly table: JsonTable<PersistedTask>;

  constructor(handle: SqliteDb) {
    this.table = new JsonTable<PersistedTask>(
      handle,
      "tasks",
      (task) => task.view.id,
      (task) => task.updated_at,
    );
  }

  save(task: PersistedTask): void {
    this.table.save(task);
  }

  load(taskId: string): PersistedTask | undefined {
    return this.table.get(taskId);
  }

  list(): PersistedTask[] {
    return this.table.list();
  }
}
