import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FileBlob, FileBlobStore, DispatchEntry, DispatchStore, PersistedTask, TaskStore } from "./stores.ts";

/**
 * One SQLite file holds all node state (§5.5): WAL mode, one process writing.
 * Every store opens it through here, so the pragmas and the closed guard are
 * the same: `stop()` can run twice, and an in-flight task may still try to
 * persist after close, so late calls become no-ops.
 */
type Db = { db: DatabaseSync; closed(): boolean; close(): void };

function openDb(path: string): Db {
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
function jsonTable<T>(
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

/**
 * Durable file-blob mapping (§5.6), in the same database as tasks so one
 * `data_root` holds all node state. The CLI writes rows directly; the gateway
 * reads them, which is why publishing needs no network route at all.
 */
export function createSqliteFileBlobStore(path: string): FileBlobStore {
  const handle = openDb(path);
  handle.db.exec(
    `CREATE TABLE IF NOT EXISTS file_blobs (
       blob_id TEXT PRIMARY KEY,
       path TEXT NOT NULL,
       size INTEGER NOT NULL,
       expires_at TEXT
     )`,
  );
  const upsert = handle.db.prepare(
    `INSERT INTO file_blobs (blob_id, path, size, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(blob_id) DO UPDATE SET path = excluded.path, size = excluded.size, expires_at = excluded.expires_at`,
  );
  const selectOne = handle.db.prepare("SELECT blob_id, path, size, expires_at FROM file_blobs WHERE blob_id = ?");
  return {
    save(blob: FileBlob): void {
      if (!handle.closed()) upsert.run(blob.blob_id, blob.path, blob.size, blob.expires_at);
    },
    get(blobId: string): FileBlob | undefined {
      const row = handle.closed() ? undefined : (selectOne.get(blobId) as FileBlob | undefined);
      return row && { ...row, size: Number(row.size) };
    },
    close: handle.close,
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
