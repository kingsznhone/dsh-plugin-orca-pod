import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

  return {
    save(task: PersistedTask): void {
      upsert.run(task.view.id, JSON.stringify(task), task.updated_at);
    },
    load(taskId: string): PersistedTask | undefined {
      const row = selectOne.get(taskId);
      return row === undefined ? undefined : parse(row);
    },
    list(): PersistedTask[] {
      return selectAll.all().map(parse);
    },
    close(): void {
      db.close();
    },
  };
}
