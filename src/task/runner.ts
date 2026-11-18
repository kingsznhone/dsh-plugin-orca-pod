/**
 * The task runner (§6.9) and the tasks it runs.
 *
 * `SingleSlotTaskRunner` is the single slot, the store and the lookups: one
 * orca node runs one task at a time, so a second task is refused with
 * `orca_node_busy`. `TaskRecord` is one task's life, a state machine
 *
 *   submitted -> working <-> input-required -> completed | failed | canceled
 *
 * where every transition goes through `move` (live states) or `finish` (the
 * single exit, which also releases everything the task holds). The executor
 * loop, the permission wait (§7.11, §7.12) and the timers all live in the
 * record. A record is built only by its runner and reads the runner's public
 * collaborators, so both stay in one file.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { assertNever } from "@deepseek-ai/dsh-util-values";

import type { FileBlobRegistry } from "../core/blobs.ts";
import { DEFAULT_TASK_TIMEOUT_S } from "../core/constants.ts";
import { errorMessage, PodError } from "../core/errors.ts";
import { EventBus, type NodeLogger } from "../core/events.ts";
import type { PermissionRequest } from "../core/wire/grant.ts";
import type { BusyState, OrcaNodeId, WorkgroupId } from "../core/wire/peer.ts";
import { narrowPermissionMode } from "../core/wire/permission.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor, Suspension } from "../executor/executor.ts";
import { checkGrant, GrantLedger } from "./grants.ts";
import { parsePodMetadata, parseResume, type TaskMeta } from "./meta.ts";
import { composePrompt, listNotes } from "./prompt.ts";
import { WorkspaceQuota } from "./quota.ts";
import { TaskSlot } from "./slot.ts";
import type { TaskStore } from "./task-store.ts";
import {
  isTerminal,
  messageText,
  newTaskId,
  textMessage,
  type A2AMessage,
  type SubmitTaskInput,
  type TaskEvent,
  type TaskState,
  type TaskView,
} from "./wire.ts";
import type { WorkspacePaths } from "./workspace.ts";

/** What the runner is configured with besides its collaborators. */
export type TaskRunnerOptions = {
  logger: NodeLogger;
  selfOrcaNodeId: OrcaNodeId;
  workgroupId: WorkgroupId;
  /** Data root, so the prompt can point an agent at the local CLI (§6.14). */
  dataRoot: string;
  /** Local ceiling for inherited origin modes; an inherited mode can only narrow it (§7.10). */
  permissionMode?: SandboxMode;
  /** Auto-reject a parked permission request after this many seconds; unset waits forever (§7.12). */
  permissionTtlS?: number;
  /** Hard cap on task lifetime; peers see it as max_task_ttl_s (§6.9). Default 3600s. */
  taskTimeoutS?: number;
  /** Inline result summary cap in bytes; longer summaries are truncated (§6.11). Default 32 KiB. */
  resultMaxBytes?: number;
  /** A new task is refused while the workspace holds more than this (§6.13). */
  maxWorkspaceBytes: number;
  maxWorkspaceFiles: number;
};

/** The options with their defaults filled in. */
type ResolvedTaskRunnerOptions = TaskRunnerOptions & { taskTimeoutS: number; resultMaxBytes: number };

type RecordInit = {
  view: TaskView;
  origin: OrcaNodeId;
  meta: TaskMeta;
  /** Task lifetime in seconds, after the local cap; paused while the task waits for input. */
  ttlS: number;
  /** The origin's task text. */
  text: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Keep the inline summary under the local cap; longer text is cut with a marker (§6.11). */
function truncateMessage(message: A2AMessage, maxBytes: number): A2AMessage {
  const text = messageText(message);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return message;
  const marker = `\n…[summary truncated at ${maxBytes} bytes]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  // Cut on the byte budget, then drop a code point the cut may have split.
  const cut = Buffer.from(text, "utf8")
    .subarray(0, budget)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return { role: message.role, parts: [{ kind: "text", text: cut + marker }] };
}

export class TaskRecord {
  readonly id: string;
  readonly origin: OrcaNodeId;
  readonly createdAt: string;
  private readonly view: TaskView;
  private readonly meta: TaskMeta;
  private readonly ttlS: number;
  private readonly text: string;
  private readonly abort = new AbortController();
  /** Effective mode: inherited and capped at the start, widened by a grant (§7.12). */
  private mode: SandboxMode;
  /** The executor run; created by `begin()` before the first `drive()`. */
  private iterator!: AsyncGenerator<ExecutorEvent, void, SandboxMode | undefined>;
  private ttl: NodeJS.Timeout | null = null;
  private permissionTimer: NodeJS.Timeout | null = null;
  /** The permission request this task is parked on, if any. */
  private wait: PermissionRequest | null = null;

  constructor(
    private readonly runner: SingleSlotTaskRunner,
    init: RecordInit,
  ) {
    this.view = init.view;
    this.id = init.view.id;
    this.origin = init.origin;
    this.createdAt = init.view.status.timestamp;
    this.meta = init.meta;
    this.ttlS = init.ttlS;
    this.text = init.text;
    // The ceiling only narrows what the origin asked for (§7.10); a grant widens it later (§7.12).
    this.mode =
      runner.options.permissionMode === undefined
        ? init.meta.permissionMode
        : narrowPermissionMode(runner.options.permissionMode, init.meta.permissionMode);
  }

  get state(): TaskState {
    return this.view.status.state;
  }

  snapshot(): TaskView {
    return structuredClone(this.view);
  }

  /** Record the new task, start its clock and run it: compose the prompt, then drive the executor. */
  begin(): void {
    this.persist();
    this.armTtl();
    this.runner.events.emit({ type: "task", view: this.snapshot() });
    void this.guarded(async () => {
      const input = await this.prepare();
      if (this.over) return;
      this.iterator = this.runner.executor.run(input, this.abort.signal);
      this.move("working");
      await this.drive();
    });
  }

  /** The origin answers a parked task: a grant or a denial. A bad answer changes nothing. */
  resume(message: A2AMessage): void {
    const wait = this.wait;
    // A task only parks on a permission request, so this is a stale or foreign resume.
    if (wait === null) throw new PodError("bad_request", "task is not waiting for a permission decision");
    const control = parseResume(message);
    // A permission suspension ends only with a grant or an explicit denial (§7.11).
    if (control === null) throw new PodError("bad_request", "resume of a permission request needs a grant or a denial");
    if (control.kind === "denied") {
      this.terminate("failed", textMessage(`permission denied: ${control.reason}`), "permission_denied");
      return;
    }
    const failure = checkGrant(
      control.grant,
      {
        taskId: this.id,
        selfOrcaNodeId: this.runner.options.selfOrcaNodeId,
        workgroupId: this.runner.options.workgroupId,
        origin: this.origin,
        pending: wait,
      },
      this.runner.ledger,
    );
    if (failure !== null) {
      this.terminate("failed", textMessage(`permission grant rejected: ${failure}`), failure);
      return;
    }
    this.runner.ledger.consume(control.grant);
    // The task runs with the granted mode until it ends; nothing else inherits it.
    this.mode = control.grant.permission_mode;
    this.proceed();
  }

  cancel(): void {
    this.terminate("canceled", undefined, "canceled");
  }

  // ---- state machine ----

  private get over(): boolean {
    return isTerminal(this.state);
  }

  private move(state: TaskState, message?: A2AMessage): void {
    this.view.status = { state, timestamp: nowIso(), message };
    this.persist();
    this.runner.events.emit({ type: "task", view: this.snapshot() });
  }

  /** The single exit: after this the task holds no timer, slot, directory or live entry. */
  private finish(state: TaskState, message: A2AMessage | undefined, reason?: string): void {
    if (this.over) return;
    this.view.status = {
      state,
      timestamp: nowIso(),
      message: message && truncateMessage(message, this.runner.options.resultMaxBytes),
      reason,
    };
    this.clearTtl();
    this.clearPermissionTimer();
    this.wait = null;
    this.runner.slot.release(this.id);
    this.persist();
    this.runner.events.emit({ type: "task", view: this.snapshot() });
    this.runner.settle(this.id);
  }

  /**
   * End a task that may still own a live executor. The terminal state is
   * recorded first, so events the executor still emits cannot overwrite it;
   * the abort then answers any pending ACP permission request and stops it.
   */
  private terminate(state: TaskState, message: A2AMessage | undefined, reason: string): void {
    if (this.over) return;
    this.finish(state, message, reason);
    this.abort.abort();
  }

  /** Back to work after a grant: re-take the slot and the clock, then restart the executor loop. */
  private proceed(): void {
    this.wait = null;
    this.clearPermissionTimer();
    this.armTtl();
    this.runner.slot.claim(this.id);
    this.move("working");
    void this.guarded(() => this.drive(this.mode));
  }

  // ---- running ----

  private async prepare(): Promise<ExecuteInput> {
    const { runner, meta } = this;
    const notes = await listNotes(runner.workspace.notes);
    return {
      taskId: this.id,
      contextId: this.view.contextId,
      prompt: composePrompt({
        taskId: this.id,
        selfOrcaNodeId: runner.options.selfOrcaNodeId,
        dataRoot: runner.options.dataRoot,
        text: this.text,
        notes,
      }),
      originOrcaNode: this.origin,
      selfOrcaNodeId: runner.options.selfOrcaNodeId,
      workspaceDir: runner.workspace.root,
      podDir: runner.workspace.state,
      permissionMode: this.mode,
      permissionCeiling: runner.options.permissionMode,
      model: meta.model,
      reasoningEffort: meta.effort,
      echo: meta.echo,
    };
  }

  /** Feed executor events into the state machine until the task ends or parks; `granted` answers the last suspension. */
  private async drive(granted?: SandboxMode): Promise<void> {
    let answer = granted;
    for (;;) {
      const step = await this.iterator.next(answer);
      answer = undefined;
      if (this.over) {
        await this.iterator.return();
        return;
      }
      if (step.done)
        return this.finish("failed", textMessage("executor exited without a terminal event"), "executor_exited");
      const event = step.value;
      switch (event.type) {
        case "suspend":
          return this.requestPermission(event.suspend);
        case "artifact":
          await this.addArtifact(event.name, event.content);
          break;
        case "completed":
          return this.finish("completed", textMessage(event.text));
        case "failed":
          return this.finish("failed", textMessage(event.text), event.reason ?? "executor_error");
        default:
          return assertNever(event);
      }
    }
  }

  /**
   * An artifact the executor hands over as text (only the echo script does):
   * written under this node's own state, outside the agent's workspace, and
   * published like any produced file (§5.6). The name is the origin's label and
   * never a path; the file is numbered.
   */
  private async addArtifact(name: string, content: string): Promise<void> {
    const dir = join(this.runner.workspace.state, "artifacts", this.id);
    const path = join(dir, String((this.view.artifacts ?? []).length + 1));
    await mkdir(dir, { recursive: true });
    await writeFile(path, content, "utf8");
    const blob = await this.runner.blobs.register(path);
    if (this.over) return;
    this.view.artifacts = [
      ...(this.view.artifacts ?? []),
      { artifactId: blob.blob_id, name, mediaType: "text/plain", bytes: blob.size },
    ];
    this.persist();
    this.runner.events.emit({ type: "task", view: this.snapshot() });
  }

  /** Ask the origin to let this task continue with a wider mode (§7.12); the executor waits for the answer. */
  private requestPermission({ tool, requested, requestedMode }: Suspension): void {
    const ttlS = this.runner.options.permissionTtlS;
    const request: PermissionRequest = {
      request_id: randomUUID(),
      task_id: this.id,
      tool,
      requested,
      requested_by: this.runner.options.selfOrcaNodeId,
      current_mode: this.mode,
      requested_mode: requestedMode,
      // No expiry by default: the origin waits however long the human takes (§7.12).
      expires_at: ttlS === undefined ? undefined : new Date(Date.now() + ttlS * 1000).toISOString(),
    };
    this.wait = request;
    this.park({ role: "agent", parts: [{ kind: "data", data: { permission_request: request } }] });
  }

  /** `input-required`: the slot is free and the TTL stands still while the task waits. */
  private park(message: A2AMessage): void {
    this.clearTtl();
    if (this.wait !== null) this.armPermissionTimer();
    this.runner.slot.release(this.id);
    this.move("input-required", message);
  }

  // ---- timers ----

  private armTtl(): void {
    this.clearTtl();
    this.ttl = setTimeout(
      () => this.terminate("failed", textMessage("task ttl exceeded"), "timeout"),
      this.ttlS * 1000,
    );
    this.ttl.unref();
  }

  /** Only when the node configures an approval timeout does a parked request expire by itself (§7.12). */
  private armPermissionTimer(): void {
    const ttlS = this.runner.options.permissionTtlS;
    if (ttlS === undefined) return;
    this.permissionTimer = setTimeout(
      () => this.terminate("failed", textMessage("permission request timed out"), "permission_timeout"),
      ttlS * 1000,
    );
    this.permissionTimer.unref();
  }

  private clearTtl(): void {
    if (this.ttl !== null) clearTimeout(this.ttl);
    this.ttl = null;
  }

  private clearPermissionTimer(): void {
    if (this.permissionTimer !== null) clearTimeout(this.permissionTimer);
    this.permissionTimer = null;
  }

  // ---- plumbing ----

  /** Run detached work: whatever it throws ends the task, never the process. */
  private async guarded(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      // A watchdog (TTL, cancel) may have ended the task already: `finish` keeps its reason.
      this.finish(
        "failed",
        textMessage(errorMessage(error)),
        error instanceof PodError ? error.code : "executor_error",
      );
    }
  }

  private persist(): void {
    this.attempt("it could not be saved", () =>
      this.runner.store.save({
        view: this.view,
        origin_orca_node: this.origin,
        created_at: this.createdAt,
        updated_at: nowIso(),
      }),
    );
  }

  /**
   * Housekeeping must not take the node down or strand a live task: a failing
   * disk is logged, and the task stays readable from memory.
   */
  private attempt(problem: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      this.runner.options.logger.warn(`task ${this.id}: ${problem}: ${errorMessage(error)}`);
    }
  }
}

const busyError = (): PodError => new PodError("orca_node_busy", "orca node is busy with another task");

export class SingleSlotTaskRunner {
  /** Fires after every observable task change, for the UI and for whoever tracks `busy()` (§9.2). */
  readonly events = new EventBus<TaskEvent>();
  readonly slot = new TaskSlot();
  readonly ledger = new GrantLedger();
  readonly quota: WorkspaceQuota;
  readonly options: ResolvedTaskRunnerOptions;
  private readonly live = new Map<string, TaskRecord>();

  constructor(
    readonly executor: LocalExecutor,
    /** Where the files a task produces are published (§5.6). */
    readonly blobs: FileBlobRegistry,
    /** Durable store (§5.5); every task change is written through it. */
    readonly store: TaskStore,
    /** Group workspace: the executor's cwd (§6.7). */
    readonly workspace: WorkspacePaths,
    options: TaskRunnerOptions,
  ) {
    this.options = {
      ...options,
      taskTimeoutS: options.taskTimeoutS ?? DEFAULT_TASK_TIMEOUT_S,
      resultMaxBytes: options.resultMaxBytes ?? 32 * 1024,
    };
    this.quota = new WorkspaceQuota(
      workspace.root,
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
    if (!this.slot.isFree()) throw busyError();
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
    const record = new TaskRecord(this, {
      view,
      origin: input.originOrcaNode,
      meta,
      ttlS: Math.min(meta.taskTtlS ?? taskTimeoutS, taskTimeoutS),
      text: messageText(input.message),
    });
    this.slot.claim(id);
    this.live.set(id, record);
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
    if (!this.slot.isFree()) throw busyError();
    record.resume(message);
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
    const { holder } = this.slot;
    const record = holder === null ? undefined : this.live.get(holder);
    return record === undefined
      ? null
      : { task_id: record.id, origin_orca_node: record.origin, since: record.createdAt };
  }

  /** §8.3: a restart never silently resumes work; every unfinished task fails. Returns how many. */
  recover(): number {
    let count = 0;
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
      count += 1;
    }
    return count;
  }

  /** A record is terminal and persisted: stop tracking it in memory and look at the workspace again. */
  settle(taskId: string): void {
    this.live.delete(taskId);
    this.quota.measure();
  }
}
