import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * One SQLite file holds all node state (§5.5): WAL mode, one process writing.
 * Every store opens it through here, so the pragmas and the closed guard are
 * the same: `stop()` can run twice, and an in-flight task may still try to
 * persist after close, so late calls become no-ops.
 */
export type Db = { db: DatabaseSync; closed(): boolean; close(): void };

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  let closed = false;
  return {
    db,
    closed: () => closed,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** A table of JSON records keyed by task id: the whole record is the payload column. */
export function jsonTable<T>(
  handle: Db,
  table: "tasks" | "dispatches",
  idOf: (item: T) => string,
  updatedAtOf: (item: T) => string,
) {
  const { db } = handle;
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       task_id TEXT PRIMARY KEY,
       payload TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  const upsert = db.prepare(
    `INSERT INTO ${table} (task_id, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  );
  const selectOne = db.prepare(`SELECT payload FROM ${table} WHERE task_id = ?`);
  const selectAll = db.prepare(`SELECT payload FROM ${table} ORDER BY updated_at`);
  const removeOne = db.prepare(`DELETE FROM ${table} WHERE task_id = ?`);
  const parse = (row: unknown): T => JSON.parse((row as { payload: string }).payload) as T;
  return {
    save(item: T): void {
      if (!handle.closed()) upsert.run(idOf(item), JSON.stringify(item), updatedAtOf(item));
    },
    get(taskId: string): T | undefined {
      const row = handle.closed() ? undefined : selectOne.get(taskId);
      return row === undefined ? undefined : parse(row);
    },
    list(): T[] {
      return handle.closed() ? [] : selectAll.all().map(parse);
    },
    remove(taskId: string): void {
      if (!handle.closed()) removeOne.run(taskId);
    },
  };
}

/** The one SQLite file of a data root: tasks, published files and the dispatch log share it. */
export function storeDbPath(dataRoot: string): string {
  return join(dataRoot, "tasks.db");
}
