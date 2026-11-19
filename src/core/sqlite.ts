import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/**
 * The one SQLite file of a data root (§5.5): tasks, published files and the
 * dispatch log share a single connection, so the pragmas and the closed guard are
 * the same for all of them: `stop()` can run twice, and an in-flight task may
 * still try to persist after close, so late calls become no-ops.
 *
 * Building it only names the file; `open()` touches the disk. The node opens it
 * after it has bound its port (§3.9), so a second process on the same data root
 * never gets as far as recovering the first one's tasks.
 */
export class SqliteDb {
  private connection: DatabaseSync | undefined;
  private isClosed = false;

  constructor(private readonly path: string) {}

  open(): void {
    if (this.connection !== undefined || this.isClosed) return;
    mkdirSync(dirname(this.path), { recursive: true });
    this.connection = new DatabaseSync(this.path);
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA synchronous = NORMAL");
  }

  /** The connection; a store that is used before `open()` is a bug, not a no-op. */
  get db(): DatabaseSync {
    if (this.connection === undefined) throw new Error("the database is not open yet");
    return this.connection;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.connection?.close();
  }
}

/** A table of JSON records keyed by task id: the whole record is the payload column. */
export class JsonTable<T> {
  /** Prepared on first use, because the database opens after the table is built; one per SQL text. */
  private readonly statements = new Map<string, StatementSync>();
  private created = false;

  constructor(
    private readonly handle: SqliteDb,
    private readonly table: "tasks" | "dispatches",
    private readonly idOf: (item: T) => string,
    private readonly updatedAtOf: (item: T) => string,
  ) {}

  save(item: T): void {
    if (this.handle.closed) return;
    this.statement(
      `INSERT INTO ${this.table} (task_id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    ).run(this.idOf(item), JSON.stringify(item), this.updatedAtOf(item));
  }

  get(taskId: string): T | undefined {
    const row = this.handle.closed
      ? undefined
      : this.statement(`SELECT payload FROM ${this.table} WHERE task_id = ?`).get(taskId);
    return row === undefined ? undefined : this.parse(row);
  }

  list(): T[] {
    return this.select("1");
  }

  /** The records for which `where`, an SQL condition over `payload`, holds; oldest update first. */
  select(where: string, ...params: SQLInputValue[]): T[] {
    if (this.handle.closed) return [];
    return this.statement(`SELECT payload FROM ${this.table} WHERE ${where} ORDER BY updated_at`)
      .all(...params)
      .map((row) => this.parse(row));
  }

  /**
   * Merge `patch` into one record in a single statement (a JSON merge patch: a
   * null field is removed), only while `where` holds for it. Returns the record as
   * written, or undefined when no record was written.
   */
  patch(
    taskId: string,
    patch: Record<string, unknown>,
    updatedAt: string,
    where: string,
    ...params: SQLInputValue[]
  ): T | undefined {
    if (this.handle.closed) return undefined;
    const row = this.statement(
      `UPDATE ${this.table} SET payload = json_patch(payload, ?), updated_at = ?
       WHERE task_id = ? AND (${where}) RETURNING payload`,
    ).get(JSON.stringify(patch), updatedAt, taskId, ...params);
    return row === undefined ? undefined : this.parse(row);
  }

  private statement(sql: string): StatementSync {
    const { db } = this.handle;
    if (!this.created) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           task_id TEXT PRIMARY KEY,
           payload TEXT NOT NULL,
           updated_at TEXT NOT NULL
         )`,
      );
      this.created = true;
    }
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private parse(row: unknown): T {
    return JSON.parse((row as { payload: string }).payload) as T;
  }
}

/** The one SQLite file of a data root: tasks, published files and the dispatch log share it. */
export function storeDbPath(dataRoot: string): string {
  return join(dataRoot, "tasks.db");
}
