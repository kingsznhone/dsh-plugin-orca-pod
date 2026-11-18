/**
 * The task runner (§6.9): the single slot, the store and the lookups. One orca
 * node runs one task at a time, so a second task is refused with
 * `orca_node_busy`. The runner builds a `TaskRecord` per task and listens to
 * it: whatever the record reports changed, the runner keeps the slot in step,
 * writes the task through to the store and tells its listeners.
 */

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";

import type { FetchBlob, FileBlobRegistry } from "../core/blobs.ts";
import { errorMessage, PodError } from "../core/errors.ts";
import { EventBus, type NodeLogger } from "../core/events.ts";
import type { BusyState, OrcaNodeId, WorkgroupId } from "../core/wire/peer.ts";
import type { LocalExecutor } from "../executor/executor.ts";
import { GrantLedger } from "./grants.ts";
import { parsePodMetadata, parseResume } from "./meta.ts";
import { WorkspaceQuota } from "./quota.ts";
import { TaskRecord, type TaskSettings } from "./record.ts";
import type { TaskStore } from "./task-store.ts";
import {
  isTerminal,
  messageText,
  newTaskId,
  type A2AMessage,
  type SubmitTaskInput,
  type TaskEvent,
  type TaskView,
} from "./wire.ts";
import type { Workspace } from "./workspace.ts";

/** What the runner is configured with besides its collaborators. */
export type TaskRunnerOptions = {
  logger: NodeLogger;
  selfOrcaNodeId: OrcaNodeId;
  workgroupId: WorkgroupId;
  /** Fetches the files an origin attaches to a task from the member that published them (§3.8). */
  fetchBlob: FetchBlob;
  /** Local ceiling for inherited origin modes; an inherited mode can only narrow it (§7.10). */
  permissionMode?: SandboxMode;
  /** Auto-reject a parked permission request after this many seconds; unset waits forever (§7.12). */
  permissionTtlS?: number;
  /** Hard cap on task lifetime; peers see it as max_task_ttl_s (§6.9). */
  taskTimeoutS: number;
  /** Inline result summary cap in bytes; longer summaries are truncated (§6.11). Default 32 KiB. */
  resultMaxBytes?: number;
  /** A new task is refused while the workspace holds more than this (§6.13). */
  maxWorkspaceBytes: number;
  maxWorkspaceFiles: number;
};

export class SingleSlotTaskRunner {
  /** Fires after every observable task change, for the UI and for whoever tracks `busy()` (§9.2). */
  readonly events: EventBus<TaskEvent>;
  private readonly ledger = new GrantLedger();
  private readonly quota: WorkspaceQuota;
  private readonly settings: TaskSettings;
  private readonly live = new Map<string, TaskRecord>();
  /** The task holding the single slot (§6.9); null when idle. A task that waits for a permission decision gives it up and takes it again when it resumes. */
  private holder: string | null = null;

  constructor(
    private readonly executor: LocalExecutor,
    /** Where the files a task produces are published (§5.6). */
    private readonly blobs: FileBlobRegistry,
    /** Durable store (§5.5); every task change is written through it. */
    private readonly store: TaskStore,
    /** Group workspace: the executor's cwd (§6.7). */
    private readonly workspace: Workspace,
    private readonly options: TaskRunnerOptions,
  ) {
    this.events = new EventBus(options.logger);
    this.settings = {
      logger: options.logger,
      selfOrcaNodeId: options.selfOrcaNodeId,
      fetchBlob: options.fetchBlob,
      maxFileBytes: options.maxWorkspaceBytes,
      permissionCeiling: options.permissionMode,
      permissionTtlS: options.permissionTtlS,
      resultMaxBytes: options.resultMaxBytes ?? 32 * 1024,
    };
    this.quota = new WorkspaceQuota(
      workspace,
      { maxBytes: options.maxWorkspaceBytes, maxFiles: options.maxWorkspaceFiles },
      options.logger,
    );
  }

  /** Fail what a restart interrupted (§8.3), then take a first look at the workspace. */
  start(): void {
    this.recover();
    this.quota.measure();
  }

  /** `input.originOrcaNode` is the authenticated caller; it is recorded for busy/holder reporting (§6.9). */
  submit(input: SubmitTaskInput & { originOrcaNode: OrcaNodeId }): TaskView {
    if (this.holder !== null) throw SingleSlotTaskRunner.busyError();
    const meta = parsePodMetadata(input.metadata);
    this.quota.assertWithin();
    const id = newTaskId();
    const view: TaskView = {
      kind: "task",
      id,
      contextId: input.message.contextId ?? id,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      // Every reader learns who dispatched the task from the view (§7.6).
      metadata: { ...input.metadata, pod: { ...input.metadata?.pod, origin_orca_node: input.originOrcaNode } },
    };
    const { taskTimeoutS } = this.options;
    const record = new TaskRecord(
      {
        view,
        origin: input.originOrcaNode,
        meta,
        ttlS: Math.min(meta.taskTtlS ?? taskTimeoutS, taskTimeoutS),
        text: messageText(input.message),
      },
      this.executor,
      this.blobs,
      this.workspace,
      this.settings,
    );
    this.live.set(id, record);
    const unsubscribe = record.changes.subscribe(() => {
      this.onChange(record);
      if (isTerminal(record.state)) {
        unsubscribe();
        this.live.delete(id);
        this.quota.measure();
      }
    });
    record.begin();
    return record.snapshot();
  }

  get(taskId: string): TaskView | null {
    return this.live.get(taskId)?.snapshot() ?? this.store.load(taskId)?.view ?? null;
  }

  /** Origin of a known task, used by the gateway to authorize cancellation (§5.3). */
  originOf(taskId: string): OrcaNodeId | null {
    return this.live.get(taskId)?.origin ?? this.store.load(taskId)?.origin_orca_node ?? null;
  }

  /**
   * Local tasks for the UI task panel (§9.2): tasks still running first, then
   * the persisted store fills the remaining budget, newest update first.
   */
  list(limit = 200): TaskView[] {
    const running = [...this.live.values()]
      .sort((left, right) => right.id.localeCompare(left.id))
      .map((record) => record.snapshot());
    if (running.length >= limit) return running.slice(0, limit);
    const stored = this.store
      .list()
      .filter((task) => !this.live.has(task.view.id))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((task) => task.view);
    return [...running, ...stored].slice(0, limit);
  }

  resume(taskId: string, message: A2AMessage, callerOrcaNode?: string): TaskView {
    const record = this.live.get(taskId);
    if (record === undefined) {
      if (this.store.load(taskId) === undefined) throw new PodError("task_not_found", `unknown task ${taskId}`);
      throw new PodError("bad_request", "task is not input-required");
    }
    // Only the task's origin drives it; other workgroup members may read it (§5.3).
    if (callerOrcaNode !== undefined && callerOrcaNode !== record.origin) {
      throw new PodError("not_task_origin", `task ${taskId} belongs to another origin`);
    }
    if (record.state !== "input-required") throw new PodError("bad_request", "task is not input-required");
    // A parked task gave up the slot: while another task holds it, the origin retries later (§6.9).
    if (this.holder !== null) throw SingleSlotTaskRunner.busyError();
    // A task only parks on a permission request, so a record without one is a stale or foreign resume.
    const waiting = record.waiting;
    if (waiting === null) throw new PodError("bad_request", "task is not waiting for a permission decision");
    const control = parseResume(message);
    // A permission suspension ends only with a grant or an explicit denial (§7.11).
    if (control === null) throw new PodError("bad_request", "resume of a permission request needs a grant or a denial");
    if (control.kind === "denied") {
      record.deny(control.reason);
    } else {
      const failure = this.ledger.accept(control.grant, {
        taskId,
        selfOrcaNodeId: this.options.selfOrcaNodeId,
        workgroupId: this.options.workgroupId,
        origin: record.origin,
        pending: waiting,
      });
      if (failure === null) record.grant(control.grant.permission_mode);
      else record.reject(failure);
    }
    return record.snapshot();
  }

  cancel(taskId: string): TaskView {
    const record = this.live.get(taskId);
    if (record === undefined) {
      const stored = this.store.load(taskId);
      if (stored === undefined) throw new PodError("task_not_found", `unknown task ${taskId}`);
      return stored.view;
    }
    record.cancel();
    return record.snapshot();
  }

  /** The task holding the single slot (§6.9); null when idle. */
  busy(): BusyState | null {
    const record = this.holder === null ? undefined : this.live.get(this.holder);
    return record === undefined
      ? null
      : { task_id: record.id, origin_orca_node: record.origin, since: record.createdAt };
  }

  /**
   * A record changed. The slot follows the state before anyone is told, so a
   * listener that reads `busy()` sees the slot as the event describes it.
   */
  private onChange(record: TaskRecord): void {
    const { state } = record;
    if (state === "submitted" || state === "working") this.holder = record.id;
    else if (this.holder === record.id) this.holder = null;
    // Housekeeping must not take the node down or strand a live task: a failing
    // disk is logged, and the task stays readable from memory.
    try {
      this.store.save({
        view: record.snapshot(),
        origin_orca_node: record.origin,
        created_at: record.createdAt,
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      this.options.logger.warn(`task ${record.id}: it could not be saved: ${errorMessage(error)}`);
    }
    this.events.emit({ type: "task", view: record.snapshot() });
  }

  /** §8.3: a restart never silently resumes work; every unfinished task fails. */
  private recover(): void {
    for (const stored of this.store.list()) {
      if (isTerminal(stored.view.status.state)) continue;
      const now = new Date().toISOString();
      const message: A2AMessage = {
        role: "agent",
        parts: [{ kind: "text", text: "task was interrupted by an orca node restart" }],
      };
      this.store.save({
        ...stored,
        view: { ...stored.view, status: { state: "failed", timestamp: now, message, reason: "node_restart" } },
        updated_at: now,
      });
    }
  }

  private static busyError(): PodError {
    return new PodError("orca_node_busy", "orca node is busy with another task");
  }
}
