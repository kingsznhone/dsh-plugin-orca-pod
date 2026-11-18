import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * One SQLite file holds all node state (§5.5): WAL mode, one process writing.
 * Every store opens it through here, so the pragmas and the closed guard are
 * the same: `stop()` can run twice, and an in-flight task may still try to
 * persist after close, so late calls become no-ops.
 *
 * A store is its connection, so opening happens in the constructor; this is the
 * one kind of object that touches the disk when it is built.
 */
export class SqliteDb {
  readonly db: DatabaseSync;
  private isClosed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
  }

  get closed(): boolean {
    return this.isClosed;
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.db.close();
  }
}

/** A table of JSON records keyed by task id: the whole record is the payload column. */
export class JsonTable<T> {
  private readonly upsert: StatementSync;
  private readonly selectOne: StatementSync;
  private readonly selectAll: StatementSync;

  constructor(
    private readonly handle: SqliteDb,
    table: "tasks" | "dispatches",
    private readonly idOf: (item: T) => string,
    private readonly updatedAtOf: (item: T) => string,
  ) {
    const { db } = handle;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (
         task_id TEXT PRIMARY KEY,
         payload TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
    this.upsert = db.prepare(
      `INSERT INTO ${table} (task_id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    );
    this.selectOne = db.prepare(`SELECT payload FROM ${table} WHERE task_id = ?`);
    this.selectAll = db.prepare(`SELECT payload FROM ${table} ORDER BY updated_at`);
  }

  save(item: T): void {
    if (!this.handle.closed) this.upsert.run(this.idOf(item), JSON.stringify(item), this.updatedAtOf(item));
  }

  get(taskId: string): T | undefined {
    const row = this.handle.closed ? undefined : this.selectOne.get(taskId);
    return row === undefined ? undefined : this.parse(row);
  }

  list(): T[] {
    return this.handle.closed ? [] : this.selectAll.all().map((row) => this.parse(row));
  }

  private parse(row: unknown): T {
    return JSON.parse((row as { payload: string }).payload) as T;
  }
}

/** The one SQLite file of a data root: tasks, published files and the dispatch log share it. */
export function storeDbPath(dataRoot: string): string {
  return join(dataRoot, "tasks.db");
}
