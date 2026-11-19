/**
 * One task's life (§6.9), a state machine
 *
 *   submitted -> working <-> input-required -> completed | failed | canceled
 *
 * where every transition goes through `move` (live states) or `finish` (the
 * single exit, which also releases everything the record itself holds). The
 * executor loop, the permission wait (§7.11, §7.12) and the timers all live
 * here. What does not: the single slot, the grant ledger, the store and the
 * events belong to the runner, which listens to `changes` and reads the state.
 */

import { randomUUID } from "node:crypto";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { assertNever } from "@deepseek-ai/dsh-util-values";

import { errorMessage, PodError } from "../core/errors.ts";
import { ChangeSignal, type NodeLogger } from "../core/events.ts";
import {
  type PermissionRequest,
  isTerminal,
  messageText,
  textMessage,
  type A2AMessage,
  type TaskState,
  type TaskView,
} from "./wire.ts";
import type { OrcaNodeId, WorkgroupId } from "../core/ids.ts";
import { narrowPermissionMode } from "../executor/permission.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor, Suspension } from "../executor/executor.ts";
import type { GrantFailure } from "./grants.ts";
import type { TaskMeta } from "./meta.ts";
import { composePrompt } from "./prompt.ts";
import type { Workspace } from "./workspace.ts";

/** How this node runs tasks: the runner and every record it builds read the same object. */
export type TaskConfig = {
  logger: NodeLogger;
  selfOrcaNodeId: OrcaNodeId;
  workgroupId: WorkgroupId;
  /** Local ceiling for inherited origin modes; an inherited mode can only narrow it (§7.10). */
  permissionCeiling?: SandboxMode;
  /** Auto-reject a parked permission request after this many seconds; unset waits forever (§7.12). */
  permissionTtlS?: number;
  /** Inline result summary cap in bytes; longer summaries are truncated (§6.11). */
  resultMaxBytes: number;
  /** Hard cap on task lifetime; peers see it as max_task_ttl_s (§6.9). */
  taskTimeoutS: number;
  /** A new task is refused while the workspace holds more than this (§6.13). */
  maxWorkspaceBytes: number;
  maxWorkspaceFiles: number;
};

type RecordInit = {
  view: TaskView;
  origin: OrcaNodeId;
  meta: TaskMeta;
  /** Task lifetime in seconds, after the local cap; paused while the task waits for input. */
  ttlS: number;
  /** The origin's task text. */
  text: string;
};

export class TaskRecord {
  readonly id: string;
  readonly origin: OrcaNodeId;
  readonly createdAt: string;
  /** Notified after every observable change of state. */
  readonly changes: ChangeSignal;
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
  private request: PermissionRequest | null = null;

  constructor(
    init: RecordInit,
    private readonly executor: LocalExecutor,
    private readonly workspace: Workspace,
    private readonly settings: TaskConfig,
  ) {
    this.view = init.view;
    this.id = init.view.id;
    this.origin = init.origin;
    this.createdAt = init.view.status.timestamp;
    this.changes = new ChangeSignal(settings.logger);
    this.meta = init.meta;
    this.ttlS = init.ttlS;
    this.text = init.text;
    // The ceiling only narrows what the origin asked for (§7.10); a grant widens it later (§7.12).
    this.mode =
      settings.permissionCeiling === undefined
        ? init.meta.permissionMode
        : narrowPermissionMode(settings.permissionCeiling, init.meta.permissionMode);
  }

  get state(): TaskState {
    return this.view.status.state;
  }

  /** The permission request the task is parked on; null while it is not waiting for a decision. */
  get waiting(): PermissionRequest | null {
    return this.request;
  }

  snapshot(): TaskView {
    return structuredClone(this.view);
  }

  /** Start the task's clock and run it: compose the prompt, then drive the executor. */
  begin(): void {
    this.armTtl();
    this.changes.notify();
    void this.guarded(async () => {
      const input = this.prepare();
      this.iterator = this.executor.run(input, this.abort.signal);
      this.move("working");
      await this.drive();
    });
  }

  /** The origin granted the parked request: the task runs with the granted mode until it ends; nothing else inherits it. */
  grant(mode: SandboxMode): void {
    this.mode = mode;
    this.proceed();
  }

  /** The origin denied the parked request. */
  deny(reason: string): void {
    this.terminate("failed", textMessage(`permission denied: ${reason}`), "permission_denied");
  }

  /** The origin's grant did not hold up. */
  reject(failure: GrantFailure): void {
    this.terminate("failed", textMessage(`permission grant rejected: ${failure}`), failure);
  }

  cancel(): void {
    this.terminate("canceled", undefined, "canceled");
  }

  // ---- state machine ----

  private get over(): boolean {
    return isTerminal(this.state);
  }

  private move(state: TaskState, message?: A2AMessage): void {
    this.view.status = { state, timestamp: new Date().toISOString(), message };
    this.changes.notify();
  }

  /** The single exit: after this the task holds no timer or permission request. */
  private finish(state: TaskState, message: A2AMessage | undefined, reason?: string): void {
    if (this.over) return;
    this.view.status = {
      state,
      timestamp: new Date().toISOString(),
      message: message && TaskRecord.truncateMessage(message, this.settings.resultMaxBytes),
      reason,
    };
    this.clearTtl();
    this.clearPermissionTimer();
    this.request = null;
    this.changes.notify();
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

  /** Back to work after a grant: re-take the clock, then restart the executor loop. */
  private proceed(): void {
    this.request = null;
    this.clearPermissionTimer();
    this.armTtl();
    this.move("working");
    void this.guarded(() => this.drive(this.mode));
  }

  // ---- running ----

  private prepare(): ExecuteInput {
    const { meta, settings, workspace } = this;
    return {
      contextId: this.view.contextId,
      prompt: composePrompt({
        taskId: this.id,
        selfOrcaNodeId: settings.selfOrcaNodeId,
        text: this.text,
      }),
      originOrcaNode: this.origin,
      workspaceDir: workspace.root,
      podDir: workspace.state,
      permissionMode: this.mode,
      permissionCeiling: settings.permissionCeiling,
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
        case "completed":
          return this.finish("completed", textMessage(event.text));
        case "failed":
          return this.finish("failed", textMessage(event.text), event.reason ?? "executor_error");
        default:
          return assertNever(event);
      }
    }
  }

  /** Ask the origin to let this task continue with a wider mode (§7.12); the executor waits for the answer. */
  private requestPermission({ tool, requested, requestedMode }: Suspension): void {
    const { permissionTtlS } = this.settings;
    const request: PermissionRequest = {
      request_id: randomUUID(),
      task_id: this.id,
      tool,
      requested,
      requested_by: this.settings.selfOrcaNodeId,
      current_mode: this.mode,
      requested_mode: requestedMode,
      // No expiry by default: the origin waits however long the human takes (§7.12).
      expires_at: permissionTtlS === undefined ? undefined : new Date(Date.now() + permissionTtlS * 1000).toISOString(),
    };
    this.request = request;
    // `input-required`: the TTL stands still while the task waits.
    this.clearTtl();
    this.armPermissionTimer();
    this.move("input-required", { role: "agent", parts: [{ kind: "data", data: { permission_request: request } }] });
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
    const { permissionTtlS } = this.settings;
    if (permissionTtlS === undefined) return;
    this.permissionTimer = setTimeout(
      () => this.terminate("failed", textMessage("permission request timed out"), "permission_timeout"),
      permissionTtlS * 1000,
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

  /** Keep the inline summary under the local cap; longer text is cut with a marker (§6.11). */
  private static truncateMessage(message: A2AMessage, maxBytes: number): A2AMessage {
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
}
