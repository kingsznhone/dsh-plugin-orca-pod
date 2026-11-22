import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The one SQLite file of a data root (design.md 4.4): tasks, published files and the
 * dispatch log share a single connection, so the pragmas and the closed guard are
 * the same for all of them: `stop()` can run twice, and an in-flight task may
 * still try to persist after close, so late calls become no-ops.
 *
 * Building it only names the file; `open()` touches the disk. The node opens it
 * after it has bound its port (implementation.md 2), so a second process configured
 * for the same port gets no further; one told to pick a free port, or given a
 * different one, can still open the same data root and recover the first one's tasks.
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
