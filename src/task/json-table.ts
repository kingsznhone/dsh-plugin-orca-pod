import type { SQLInputValue, StatementSync } from "node:sqlite";

import type { SqliteDb } from "../core/sqlite.ts";

/** Default row cap for recent task and dispatch queries. */
export const DEFAULT_RECENT_LIMIT = 10;

/** Filtering and pagination options pushed down to SQLite `ORDER BY updated_at DESC, task_id DESC LIMIT ? OFFSET ?`. */
export interface RecentOptions {
  offset?: number;
  /** Return only records with `updated_at < before` (ISO timestamp cursor). */
  before?: string;
  /** Optional SQL condition over `payload` / columns. */
  where?: string;
  params?: readonly SQLInputValue[];
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
    /** Additional idempotent `CREATE INDEX IF NOT EXISTS ...` statements for this table. */
    private readonly indexes: readonly string[] = [],
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

  /** The newest `limit` records matching `options`, newest update first, paged in SQLite. */
  recent(limit: number = DEFAULT_RECENT_LIMIT, options: RecentOptions = {}): T[] {
    if (this.handle.closed || limit <= 0) return [];
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.where !== undefined) {
      clauses.push(`(${options.where})`);
      if (options.params !== undefined) params.push(...options.params);
    }
    if (options.before !== undefined) {
      clauses.push("updated_at < ?");
      params.push(options.before);
    }
    const whereSql = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")} `;
    const offset = Math.max(0, options.offset ?? 0);
    params.push(limit, offset);
    return this.statement(
      `SELECT payload FROM ${this.table} ${whereSql}ORDER BY updated_at DESC, task_id DESC LIMIT ? OFFSET ?`,
    )
      .all(...params)
      .map((row) => this.parse(row));
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
   * null field is removed), only while `where` holds for it.
   */
  patch(
    taskId: string,
    patch: Record<string, unknown>,
    updatedAt: string,
    where: string,
    ...params: SQLInputValue[]
  ): void {
    if (this.handle.closed) return;
    this.statement(
      `UPDATE ${this.table} SET payload = json_patch(payload, ?), updated_at = ?
       WHERE task_id = ? AND (${where})`,
    ).run(JSON.stringify(patch), updatedAt, taskId, ...params);
  }

  private statement(sql: string): StatementSync {
    const { db } = this.handle;
    if (!this.created) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           task_id TEXT PRIMARY KEY,
           payload TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_${this.table}_updated_at
           ON ${this.table} (updated_at DESC, task_id DESC);`,
      );
      for (const indexSql of this.indexes) db.exec(indexSql);
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
