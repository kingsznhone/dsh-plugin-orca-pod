/** Durable and in-memory origin-side dispatch log stores (§8.3). */

import { jsonTable, openDb } from "../core/sqlite.ts";
import type { DispatchEntry } from "./wire.ts";

// Origin-side dispatch log (§8.3); what the entries mean is decided in `task/delegation.ts` (`markInFlightUnknown`).

export type DispatchStore = {
  save(entry: DispatchEntry): void;
  get(taskId: string): DispatchEntry | undefined;
  list(): DispatchEntry[];
  remove(taskId: string): void;
  close(): void;
};

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

/**
 * Durable origin-side dispatch log (§8.3), in the same database as tasks and
 * file blobs. Entries survive a restart; reconciliation marks in-flight rows
 * `unknown` instead of inventing a failure (§8.3).
 */
export function createSqliteDispatchStore(path: string): DispatchStore {
  const handle = openDb(path);
  const table = jsonTable<DispatchEntry>(
    handle,
    "dispatches",
    (entry) => entry.task_id,
    (entry) => entry.updated_at,
  );
  return {
    save: table.save,
    get: table.get,
    list: table.list,
    remove: table.remove,
    close: handle.close,
  };
}
