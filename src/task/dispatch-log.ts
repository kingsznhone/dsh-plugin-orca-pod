import type { SessionId } from "@deepseek-ai/dsh-session";

import { EventBus, type NodeLogger } from "../core/events.ts";
import { JsonTable } from "./json-table.ts";
import type { SqliteDb } from "../core/sqlite.ts";
import type { OrcaNodeId } from "../core/ids.ts";
import { TERMINAL_STATES, type DispatchEntry, type DispatchEvent, type TaskView } from "./wire.ts";

/** The SQL condition "this entry's task has not ended". */
const OPEN = `json_extract(payload, '$.state') NOT IN (${TERMINAL_STATES.map((state) => `'${state}'`).join(", ")})`;

/**
 * Origin-side dispatch log (§8.3), in the `dispatches` table of the node's
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
  /** An entry was added or its state changed. */
  readonly events: EventBus<DispatchEvent>;
  private readonly table: JsonTable<DispatchEntry>;

  constructor(db: SqliteDb, logger: NodeLogger) {
    this.events = new EventBus(logger);
    this.table = new JsonTable<DispatchEntry>(
      db,
      "dispatches",
      (entry) => entry.task_id,
      (entry) => entry.updated_at,
    );
  }

  /** Entries, oldest update first. */
  list(): DispatchEntry[] {
    return this.table.list();
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
      context_id: view.contextId,
      state: view.status.state,
      last_error: view.status.reason,
      created_at: now,
      updated_at: now,
    };
    this.table.save(entry);
    this.events.emit({ type: "dispatch", entry });
  }

  /** The tracker read the task: record what it said. Nothing is written when nothing changed. */
  update(view: TaskView): void {
    this.changed(this.write(view.id, view.status.state, view.status.reason));
  }

  /** The tracker could not read the task (gone, refused, or no answer): the origin records it as failed. */
  fail(taskId: string, reason: string): void {
    this.changed(this.write(taskId, "failed", reason));
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
   * patch: a missing error removes the field). The entry as written, or
   * undefined when nothing was written.
   */
  private write(
    taskId: string,
    state: DispatchEntry["state"],
    lastError: string | undefined,
  ): DispatchEntry | undefined {
    const now = new Date().toISOString();
    return this.table.patch(
      taskId,
      { state, last_error: lastError ?? null, updated_at: now },
      now,
      `${OPEN} AND (json_extract(payload, '$.state') IS NOT ? OR json_extract(payload, '$.last_error') IS NOT ?)`,
      state,
      lastError ?? null,
    );
  }

  private changed(entry: DispatchEntry | undefined): void {
    if (entry !== undefined) this.events.emit({ type: "dispatch", entry });
  }
}
