/**
 * The task runner (design.md 5.3): the single slot, the store and the lookups.
 * One orca node runs one task at a time, so a second task is refused with
 * `orca_node_busy`. The runner builds a `TaskRecord` per task and listens to
 * it: whatever the record reports changed, the runner writes the task through to
 * the store and drops it once it ends. Origin nodes learn about changes by
 * polling (design.md 3.5); the runner notifies no one.
 */

import type { SQLInputValue } from "node:sqlite";

import { errorMessage, PodError } from "../core/errors.ts";
import { DEFAULT_RECENT_LIMIT, JsonTable } from "./json-table.ts";
import type { SqliteDb } from "../core/sqlite.ts";
import type { NodeLogger } from "../core/events.ts";
import {
  type BusyState,
  isTerminal,
  resumeControlOf,
  TERMINAL_STATES,
  textMessage,
  type A2AMessage,
  type SubmitTaskInput,
  type TaskState,
  type TaskView,
} from "./wire.ts";
import type { OrcaNodeId } from "../core/ids.ts";
import type { LocalExecutor } from "../executor/executor.ts";
import { ulid } from "ulid";

import { WorkspaceQuota } from "./quota.ts";
import { TaskRecord, type TaskSettings } from "./record.ts";
import type { Workspace } from "./workspace.ts";

/** The SQL condition "this task has not ended". */
const NON_TERMINAL = `json_extract(payload, '$.status.state') NOT IN (${TERMINAL_STATES.map((state) => `'${state}'`).join(", ")})`;

/** Partial index keeping startup recovery over unfinished tasks O(active), not O(history). */
const ACTIVE_INDEX = `CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks (updated_at) WHERE ${NON_TERMINAL}`;

/** Filtering and pagination options for `SingleSlotTaskRunner.list`. */
export interface TaskListOptions {
  offset?: number;
  before?: string;
  state?: TaskState;
  origin?: OrcaNodeId;
}

export class SingleSlotTaskRunner {
  private readonly quota: WorkspaceQuota;
  /**
   * The `tasks` table (design.md 4.4): each task as the gateway serves it. Its origin is in
   * its metadata, and its last change is its status timestamp.
   */
  private readonly store: JsonTable<TaskView>;
  private readonly live = new Map<string, TaskRecord>();

  constructor(
    private readonly executor: LocalExecutor,
    /** The node's database: every task change is written through to its `tasks` table (design.md 4.4). */
    db: SqliteDb,
    /** Group workspace: the executor's cwd (design.md 5.4). */
    private readonly workspace: Workspace,
    private readonly settings: TaskSettings,
    /** This node: the one caller besides the origin that may cancel. */
    private readonly selfOrcaNodeId: OrcaNodeId,
    private readonly logger: NodeLogger,
  ) {
    this.store = new JsonTable<TaskView>(
      db,
      "tasks",
      (view) => view.id,
      (view) => view.status.timestamp,
      [ACTIVE_INDEX],
    );
    this.quota = new WorkspaceQuota(workspace, settings.max_workspace_bytes, logger);
  }

  /** Fail what a restart interrupted (design.md 3.6), then take a first look at the workspace. */
  start(): void {
    this.recover();
    this.quota.measure();
  }

  /** `origin` is the authenticated caller; it is recorded for busy/holder reporting (design.md 5.3). */
  submit(input: SubmitTaskInput, origin: OrcaNodeId): TaskView {
    if (this.busy() !== null) throw SingleSlotTaskRunner.busyError();
    this.quota.assertWithin();
    // A ULID (48-bit millisecond timestamp + 80 random bits from `crypto.getRandomValues`,
    // Crockford base32): time-ordered, 26 chars, unguessable enough to act as a capability handle (design.md 4.4).
    const id = ulid();
    const view: TaskView = {
      kind: "task",
      id,
      contextId: input.message.contextId ?? id,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      // Every reader learns who dispatched the task from the view (design.md 4.1).
      metadata: { ...input.metadata, pod: { ...input.metadata?.pod, origin_orca_node: origin } },
    };
    const record: TaskRecord = new TaskRecord(
      { view, origin, message: input.message },
      this.executor,
      this.workspace,
      this.settings,
      this.selfOrcaNodeId,
      () => this.onChange(record),
    );
    this.live.set(id, record);
    // The answer is the task as accepted: it starts working right after.
    const accepted = record.snapshot();
    record.begin();
    return accepted;
  }

  get(taskId: string): TaskView | null {
    return this.live.get(taskId)?.snapshot() ?? this.store.get(taskId) ?? null;
  }

  /**
   * Local tasks for the UI task panel (implementation.md 3, 4) and agent
   * history queries: defaults to the newest 10 records via an indexed
   * `ORDER BY updated_at DESC LIMIT ?`. Without filters or paging, tasks still
   * running appear first.
   */
  list(limit: number = DEFAULT_RECENT_LIMIT, options?: TaskListOptions): TaskView[] {
    if (limit <= 0) return [];
    const hasFilter =
      options !== undefined &&
      (options.offset !== undefined ||
        options.before !== undefined ||
        options.state !== undefined ||
        options.origin !== undefined);
    if (!hasFilter) {
      const running = [...this.live.values()]
        .sort((left, right) => right.id.localeCompare(left.id))
        .map((record) => record.snapshot());
      if (running.length >= limit) return running.slice(0, limit);
      const remaining = limit - running.length;
      const stored = this.store
        .recent(remaining + this.live.size)
        .filter((view) => !this.live.has(view.id))
        .slice(0, remaining);
      return [...running, ...stored];
    }
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.state !== undefined) {
      clauses.push("json_extract(payload, '$.status.state') = ?");
      params.push(options.state);
    }
    if (options.origin !== undefined) {
      clauses.push("json_extract(payload, '$.metadata.pod.origin_orca_node') = ?");
      params.push(options.origin);
    }
    return this.store
      .recent(limit, {
        offset: options.offset,
        before: options.before,
        where: clauses.length === 0 ? undefined : clauses.join(" AND "),
        params,
      })
      .map((view) => this.live.get(view.id)?.snapshot() ?? view);
  }

  resume(taskId: string, message: A2AMessage, callerOrcaNode: string): TaskView {
    const record = this.live.get(taskId);
    if (record === undefined) {
      if (this.store.get(taskId) === undefined) throw new PodError("task_not_found", `unknown task ${taskId}`);
      throw new PodError("bad_request", "task is not input-required");
    }
    // Only the task's origin drives it; other workgroup members may read it (design.md 4.3).
    if (callerOrcaNode !== record.origin) {
      throw new PodError("not_task_origin", `task ${taskId} belongs to another origin`);
    }
    if (record.state !== "input-required") throw new PodError("bad_request", "task is not input-required");
    // A task only parks on a permission request, so a record without one is a stale or foreign resume.
    const waiting = record.waiting;
    if (waiting === null) throw new PodError("bad_request", "task is not waiting for a permission decision");
    const control = resumeControlOf(message);
    // A permission suspension ends only with an approval or an explicit denial (design.md 6.4).
    if (control === null) {
      throw new PodError("bad_request", "resume of a permission request needs an approval or a denial");
    }
    if ("permission_denied" in control) {
      // Denial terminates the parked task immediately without re-acquiring the single slot,
      // so it succeeds even while another task is running.
      record.deny(control.reason);
    } else {
      // An approval answers exactly the request the task is parked on; one for an earlier request is stale.
      if (control.request_id !== waiting.request_id) {
        throw new PodError(
          "bad_request",
          `the approval answers request ${control.request_id}, not ${waiting.request_id}`,
        );
      }
      // A parked task gave up the slot: while another task holds it, the origin retries later (design.md 5.3).
      if (this.busy() !== null) throw SingleSlotTaskRunner.busyError();
      record.grant();
    }
    return record.snapshot();
  }

  /** Only the task's origin, or this node itself (its own control paths), may cancel it (design.md 4.3). */
  cancel(taskId: string, caller: OrcaNodeId): TaskView {
    const view = this.get(taskId);
    if (view === null) throw new PodError("task_not_found", `unknown task ${taskId}`);
    if (caller !== view.metadata?.pod?.origin_orca_node && caller !== this.selfOrcaNodeId) {
      throw new PodError("not_task_origin", "only the task origin may cancel it");
    }
    const record = this.live.get(taskId);
    if (record === undefined) return view;
    record.cancel();
    return record.snapshot();
  }

  /** The task holding the single slot (design.md 5.3); null when idle. A task waiting for a permission decision does not hold it. */
  busy(): BusyState | null {
    for (const record of this.live.values()) {
      if (record.state === "submitted" || record.state === "working") {
        return { task_id: record.id, origin_orca_node: record.origin, since: record.createdAt };
      }
    }
    return null;
  }

  /** A record changed: store it, and let go of it once it ended. */
  private onChange(record: TaskRecord): void {
    // Housekeeping must not take the node down or strand a live task: a failing
    // disk is logged, and the task stays readable from memory.
    try {
      this.store.save(record.snapshot());
    } catch (error) {
      this.logger.warn(`task ${record.id}: it could not be saved: ${errorMessage(error)}`);
    }
    if (isTerminal(record.state)) {
      this.live.delete(record.id);
      this.quota.measure();
    }
  }

  /** design.md 3.6: a restart never silently resumes work; every unfinished task fails. */
  private recover(): void {
    for (const view of this.store.select(NON_TERMINAL)) {
      const message = textMessage("task was interrupted by an orca node restart");
      const status = { state: "failed" as const, timestamp: new Date().toISOString(), message, reason: "node_restart" };
      this.store.save({ ...view, status });
    }
  }

  private static busyError(): PodError {
    return new PodError("orca_node_busy", "orca node is busy with another task");
  }
}
