import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FileBlob, FileBlobStore } from "./blob-files.ts";
import type { PersistedTask, TaskStore } from "./storage.ts";

export type SqliteTaskStore = TaskStore & { close(): void };

/**
 * Durable task store (§5.5): one SQLite file, WAL mode, one process writing.
 * The payload column holds the whole record as JSON — the shape is still
 * moving in Phase 2; splitting columns buys nothing until it settles.
 */
export function createSqliteTaskStore(path: string): SqliteTaskStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(
    `CREATE TABLE IF NOT EXISTS tasks (
       task_id TEXT PRIMARY KEY,
       payload TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  );
  const upsert = db.prepare(
    `INSERT INTO tasks (task_id, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  );
  const selectOne = db.prepare("SELECT payload FROM tasks WHERE task_id = ?");
  const selectAll = db.prepare("SELECT payload FROM tasks ORDER BY updated_at");

  function parse(row: unknown): PersistedTask {
    return JSON.parse((row as { payload: string }).payload) as PersistedTask;
  }

  // stop() can run twice (teardown + explicit stop); an in-flight pump may still
  // try to persist after close, so late saves become no-ops.
  let closed = false;

  return {
    save(task: PersistedTask): void {
      if (closed) return;
      upsert.run(task.view.id, JSON.stringify(task), task.updated_at);
    },
    load(taskId: string): PersistedTask | undefined {
      if (closed) return undefined;
      const row = selectOne.get(taskId);
      return row === undefined ? undefined : parse(row);
    },
    list(): PersistedTask[] {
      if (closed) return [];
      return selectAll.all().map(parse);
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

export type SqliteFileBlobStore = FileBlobStore & { close(): void };

/**
 * Durable file-blob mapping (§5.6), in the same database as tasks so one
 * `data_root` holds all node state. The CLI writes rows directly; the gateway
 * reads them, which is why publishing needs no network route at all.
 */
export function createSqliteFileBlobStore(path: string): SqliteFileBlobStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(
    `CREATE TABLE IF NOT EXISTS file_blobs (
       blob_id TEXT PRIMARY KEY,
       path TEXT NOT NULL,
       size INTEGER NOT NULL,
       expires_at TEXT
     )`,
  );
  const upsert = db.prepare(
    `INSERT INTO file_blobs (blob_id, path, size, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(blob_id) DO UPDATE SET path = excluded.path, size = excluded.size, expires_at = excluded.expires_at`,
  );
  const selectOne = db.prepare("SELECT blob_id, path, size, expires_at FROM file_blobs WHERE blob_id = ?");

  let closed = false;
  return {
    save(blob: FileBlob): void {
      if (closed) return;
      upsert.run(blob.blob_id, blob.path, blob.size, blob.expires_at);
    },
    get(blobId: string): FileBlob | undefined {
      if (closed) return undefined;
      const row = selectOne.get(blobId) as
        | { blob_id: string; path: string; size: number; expires_at: string | null }
        | undefined;
      if (row === undefined) return undefined;
      return { blob_id: row.blob_id, path: row.path, size: Number(row.size), expires_at: row.expires_at };
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
