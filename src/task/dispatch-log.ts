import type { SQLInputValue } from "node:sqlite";
import type { SessionId } from "@deepseek-ai/dsh-session";

import { DEFAULT_RECENT_LIMIT, JsonTable } from "./json-table.ts";
import type { SqliteDb } from "../core/sqlite.ts";
import type { OrcaNodeId } from "../core/ids.ts";
import { TERMINAL_STATES, type DispatchEntry, type TaskView } from "./wire.ts";

/** The SQL condition "this entry's task has not ended". */
const OPEN = `json_extract(payload, '$.state') NOT IN (${TERMINAL_STATES.map((state) => `'${state}'`).join(", ")})`;

/** Partial index keeping tracker polls over open dispatches O(open), not O(history). */
const OPEN_INDEX = `CREATE INDEX IF NOT EXISTS idx_dispatches_open ON dispatches (updated_at) WHERE ${OPEN}`;

/** Filtering and pagination options for `DispatchLog.recent`. */
export interface DispatchQueryOptions {
  offset?: number;
  before?: string;
  state?: DispatchEntry["state"];
  node?: OrcaNodeId;
}

/**
 * Origin-side dispatch log (design.md 4.2), in the `dispatches` table of the node's
 * database: entries survive a restart.
 *
 * A task belongs to the node that created it (`origin_orca_node`), and the target
 * keeps the durable record. The origin keeps its own small log of "what did I hand
 * to whom, and what did I last hear": after an origin restart the tasks it
 * dispatched are still running on other machines, and the origin must be able to
 * tell what it knows and what it no longer knows.
 *
 * Writes are split by who makes them: a send adds the entry (`recordSend`), and
 * from then on only the tracker changes its state (`update`, `fail`), one UPDATE
 * per change, so a reader never sees half of one. Reads elsewhere (`status`, the
 * panel) never write. Entries still in flight when the process restarted are
 * marked `unknown`; the tracker's next read replaces that with the real state.
 */
export class DispatchLog {
  private readonly table: JsonTable<DispatchEntry>;

  constructor(db: SqliteDb) {
    this.table = new JsonTable<DispatchEntry>(
      db,
      "dispatches",
      (entry) => entry.task_id,
      (entry) => entry.updated_at,
      [OPEN_INDEX],
    );
  }

  /** One entry by task id, or undefined if this node never dispatched it. */
  get(taskId: string): DispatchEntry | undefined {
    return this.table.get(taskId);
  }

  /** Entries, oldest update first. */
  list(): DispatchEntry[] {
    return this.table.list();
  }

  /** The newest `limit` entries (default 10), newest update first, filtered and paged in SQLite. */
  recent(limit: number = DEFAULT_RECENT_LIMIT, options: DispatchQueryOptions = {}): DispatchEntry[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.state !== undefined) {
      clauses.push("json_extract(payload, '$.state') = ?");
      params.push(options.state);
    }
    if (options.node !== undefined) {
      clauses.push("json_extract(payload, '$.node') = ?");
      params.push(options.node);
    }
    return this.table.recent(limit, {
      offset: options.offset,
      before: options.before,
      where: clauses.length === 0 ? undefined : clauses.join(" AND "),
      params,
    });
  }

  /** Entries whose task has not ended: what the tracker reads this round. */
  open(): DispatchEntry[] {
    return this.table.select(OPEN);
  }

  /**
   * Only `sendTask` means "this origin dispatched it": reads must never create
   * entries. `agentId` is the DSH session that dispatched it, which the tracker
   * tells when the task ends.
   */
  recordSend(node: OrcaNodeId, view: TaskView, agentId?: SessionId): void {
    const now = new Date().toISOString();
    const entry: DispatchEntry = {
      task_id: view.id,
      node,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
      state: view.status.state,
      last_error: view.status.reason,
      created_at: now,
      updated_at: now,
    };
    this.table.save(entry);
  }

  /** The tracker read the task: record what it said. Nothing is written when nothing changed. */
  update(view: TaskView): void {
    this.write(view.id, view.status.state, view.status.reason);
  }

  /** The tracker could not read the task (gone, refused, or no answer): the origin records it as failed. */
  fail(taskId: string, reason: string): void {
    this.write(taskId, "failed", reason);
  }

  /**
   * On startup, mark every non-terminal entry `unknown` — the origin cannot know
   * what the remote task did while the origin was down.
   */
  markInFlightUnknown(): void {
    for (const entry of this.open()) this.write(entry.task_id, "unknown", "origin_restart");
  }

  /**
   * Set one entry's state in a single statement, only while its task has not
   * ended and when the state or the error differs from what it holds (a merge
   * patch: a missing error removes the field).
   */
  private write(taskId: string, state: DispatchEntry["state"], lastError: string | undefined): void {
    const now = new Date().toISOString();
    this.table.patch(
      taskId,
      { state, last_error: lastError ?? null, updated_at: now },
      now,
      `${OPEN} AND (json_extract(payload, '$.state') IS NOT ? OR json_extract(payload, '$.last_error') IS NOT ?)`,
      state,
      lastError ?? null,
    );
  }
}
