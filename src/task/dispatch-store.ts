/** Durable and in-memory origin-side dispatch log stores (§8.3). */

import { JsonTable, SqliteDb } from "../core/sqlite.ts";
import type { DispatchEntry } from "./wire.ts";

/** What an origin keeps about the tasks it handed to peers; what the entries mean is decided in `task/delegation.ts`. */
export interface DispatchStore {
  save(entry: DispatchEntry): void;
  get(taskId: string): DispatchEntry | undefined;
  list(): DispatchEntry[];
  remove(taskId: string): void;
  close(): void;
}

export class MemoryDispatchStore implements DispatchStore {
  private readonly entries = new Map<string, DispatchEntry>();

  save(entry: DispatchEntry): void {
    this.entries.set(entry.task_id, entry);
  }

  get(taskId: string): DispatchEntry | undefined {
    return this.entries.get(taskId);
  }

  list(): DispatchEntry[] {
    return [...this.entries.values()].sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  remove(taskId: string): void {
    this.entries.delete(taskId);
  }

  close(): void {}
}

/**
 * Durable origin-side dispatch log (§8.3), in the same database as tasks and
 * file blobs. Entries survive a restart; reconciliation marks in-flight rows
 * `unknown` instead of inventing a failure (§8.3).
 */
export class SqliteDispatchStore implements DispatchStore {
  private readonly handle: SqliteDb;
  private readonly table: JsonTable<DispatchEntry>;

  constructor(path: string) {
    this.handle = new SqliteDb(path);
    this.table = new JsonTable<DispatchEntry>(
      this.handle,
      "dispatches",
      (entry) => entry.task_id,
      (entry) => entry.updated_at,
    );
  }

  save(entry: DispatchEntry): void {
    this.table.save(entry);
  }

  get(taskId: string): DispatchEntry | undefined {
    return this.table.get(taskId);
  }

  list(): DispatchEntry[] {
    return this.table.list();
  }

  remove(taskId: string): void {
    this.table.remove(taskId);
  }

  close(): void {
    this.handle.close();
  }
}
