/**
 * The task runner (§6.9): the single slot, the store and the lookups. One orca
 * node runs one task at a time, so a second task is refused with
 * `orca_node_busy`. The runner builds a `TaskRecord` per task and listens to
 * it: whatever the record reports changed, the runner writes the task through to
 * the store and tells its listeners.
 */

import { errorMessage, PodError } from "../core/errors.ts";
import { JsonTable } from "./json-table.ts";
import type { SqliteDb } from "../core/sqlite.ts";
import type { NodeLogger } from "../core/events.ts";
import {
  type BusyState,
  isTerminal,
  resumeControlOf,
  textMessage,
  type A2AMessage,
  type SubmitTaskInput,
  type TaskView,
} from "./wire.ts";
import type { OrcaNodeId } from "../core/ids.ts";
import type { LocalExecutor } from "../executor/executor.ts";
import { ulid } from "ulid";

import { WorkspaceQuota } from "./quota.ts";
import { TaskRecord, type TaskSettings } from "./record.ts";
import type { Workspace } from "./workspace.ts";

export class SingleSlotTaskRunner {
  private readonly quota: WorkspaceQuota;
  /**
   * The `tasks` table (§5.5): each task as the gateway serves it. Its origin is in
   * its metadata, and its last change is its status timestamp.
   */
  private readonly store: JsonTable<TaskView>;
  private readonly live = new Map<string, TaskRecord>();

  constructor(
    private readonly executor: LocalExecutor,
    /** The node's database: every task change is written through to its `tasks` table (§5.5). */
    db: SqliteDb,
    /** Group workspace: the executor's cwd (§6.7). */
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
    );
    this.quota = new WorkspaceQuota(workspace, settings.max_workspace_bytes, logger);
  }

  /** Fail what a restart interrupted (§8.3), then take a first look at the workspace. */
  start(): void {
    this.recover();
    this.quota.measure();
  }

  /** `origin` is the authenticated caller; it is recorded for busy/holder reporting (§6.9). */
  submit(input: SubmitTaskInput, origin: OrcaNodeId): TaskView {
    if (this.busy() !== null) throw SingleSlotTaskRunner.busyError();
    this.quota.assertWithin();
    // A ULID (48-bit millisecond timestamp + 80 random bits from `crypto.getRandomValues`,
    // Crockford base32): time-ordered, 26 chars, unguessable enough to act as a capability handle (§5.5).
    const id = ulid();
    const view: TaskView = {
      kind: "task",
      id,
      contextId: input.message.contextId ?? id,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      // Every reader learns who dispatched the task from the view (§7.6).
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
   * Local tasks for the UI task panel (§9.2): tasks still running first, then
   * the persisted store fills the remaining budget, newest update first.
   */
  list(limit: number): TaskView[] {
    const running = [...this.live.values()]
      .sort((left, right) => right.id.localeCompare(left.id))
      .map((record) => record.snapshot());
    if (running.length >= limit) return running.slice(0, limit);
    const stored = this.store
      .list()
      .filter((view) => !this.live.has(view.id))
      .sort((left, right) => right.status.timestamp.localeCompare(left.status.timestamp));
    return [...running, ...stored].slice(0, limit);
  }

  resume(taskId: string, message: A2AMessage, callerOrcaNode: string): TaskView {
    const record = this.live.get(taskId);
    if (record === undefined) {
      if (this.store.get(taskId) === undefined) throw new PodError("task_not_found", `unknown task ${taskId}`);
      throw new PodError("bad_request", "task is not input-required");
    }
    // Only the task's origin drives it; other workgroup members may read it (§5.3).
    if (callerOrcaNode !== record.origin) {
      throw new PodError("not_task_origin", `task ${taskId} belongs to another origin`);
    }
    if (record.state !== "input-required") throw new PodError("bad_request", "task is not input-required");
    // A parked task gave up the slot: while another task holds it, the origin retries later (§6.9).
    if (this.busy() !== null) throw SingleSlotTaskRunner.busyError();
    // A task only parks on a permission request, so a record without one is a stale or foreign resume.
    const waiting = record.waiting;
    if (waiting === null) throw new PodError("bad_request", "task is not waiting for a permission decision");
    const control = resumeControlOf(message);
    // A permission suspension ends only with an approval or an explicit denial (§7.11).
    if (control === null) {
      throw new PodError("bad_request", "resume of a permission request needs an approval or a denial");
    }
    if ("permission_denied" in control) {
      record.deny(control.reason);
    } else {
      // An approval answers exactly the request the task is parked on; one for an earlier request is stale.
      if (control.request_id !== waiting.request_id) {
        throw new PodError(
          "bad_request",
          `the approval answers request ${control.request_id}, not ${waiting.request_id}`,
        );
      }
      record.grant();
    }
    return record.snapshot();
  }

  /** Only the task's origin, or this node itself (its own control paths), may cancel it (§5.3). */
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

  /** The task holding the single slot (§6.9); null when idle. A task waiting for a permission decision does not hold it. */
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

  /** §8.3: a restart never silently resumes work; every unfinished task fails. */
  private recover(): void {
    for (const view of this.store.list()) {
      if (isTerminal(view.status.state)) continue;
      const message = textMessage("task was interrupted by an orca node restart");
      const status = { state: "failed" as const, timestamp: new Date().toISOString(), message, reason: "node_restart" };
      this.store.save({ ...view, status });
    }
  }

  private static busyError(): PodError {
    return new PodError("orca_node_busy", "orca node is busy with another task");
  }
}
