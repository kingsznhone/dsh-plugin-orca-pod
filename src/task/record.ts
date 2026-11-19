/**
 * One task's life (§6.9), a state machine
 *
 *   submitted -> working <-> input-required -> completed | failed | canceled
 *
 * where every transition goes through `move` (live states) or `finish` (the
 * single exit, which also releases everything the record itself holds). The
 * executor loop, the permission wait (§7.11, §7.12) and the timers all live
 * here. What does not: the single slot and the store belong to the runner,
 * which the record calls after every change and which reads the state.
 */

import { randomUUID } from "node:crypto";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { z } from "zod";

import { errorMessage, PodError } from "../core/errors.ts";
import {
  type PermissionRequest,
  isTerminal,
  messageText,
  textMessage,
  type A2AMessage,
  type PodTaskMetadata,
  type TaskState,
  type TaskView,
} from "./wire.ts";
import type { OrcaNodeId } from "../core/ids.ts";
import { narrowPermissionMode, SandboxModeSchema } from "../executor/permission.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor, Suspension } from "../executor/executor.ts";
import { composePrompt } from "./prompt.ts";
import type { Workspace } from "./workspace.ts";

const PositiveNumber = z.number().positive();
const PositiveInteger = z.number().int().min(1);

/**
 * The node settings that say how it runs tasks for others. They are part of the
 * node's settings (`node/settings.ts` spreads them in) and declared here, where
 * they are read: the runner and every record it builds read the same object.
 */
export const TaskSettingsSchema = z.object({
  /** Local ceiling for tasks this orca node runs; origin sessions can only narrow it (§7.10). */
  permission_mode: SandboxModeSchema.optional(),
  /** Hard cap on a task's lifetime (§6.9). */
  task_timeout_s: PositiveNumber.default(3600),
  /** A new task is refused while the group workspace holds more bytes than this (§6.13). */
  max_workspace_bytes: PositiveInteger.default(5 * 1024 ** 3),
});
export type TaskSettings = z.output<typeof TaskSettingsSchema>;

/** Inline result summary cap in bytes; a longer summary is truncated (§6.11). */
const RESULT_MAX_BYTES = 32 * 1024;

type RecordInit = {
  /** The task as accepted; its `metadata.pod` is what the origin asked for (§5.1). */
  view: TaskView;
  origin: OrcaNodeId;
  /** The origin's message: the task text. */
  message: A2AMessage;
};

export class TaskRecord {
  readonly id: string;
  readonly origin: OrcaNodeId;
  readonly createdAt: string;
  private readonly view: TaskView;
  /** What is left of the task's lifetime; the clock runs only while the task works. */
  private ttlLeftMs: number;
  /** When the running lifetime runs out (`Date.now()` time); null while the clock stands still. */
  private ttlDeadline: number | null = null;
  private readonly text: string;
  private readonly abort = new AbortController();
  /** Effective mode: inherited and capped at the start, widened by the origin's approval (§7.12). */
  private mode: SandboxMode;
  /** The executor run; created by `begin()` before the first `drive()`. */
  private iterator!: AsyncGenerator<ExecutorEvent, void, void>;
  private ttl: NodeJS.Timeout | null = null;
  private request: PermissionRequest | null = null;

  constructor(
    init: RecordInit,
    private readonly executor: LocalExecutor,
    private readonly workspace: Workspace,
    private readonly settings: TaskSettings,
    /** The node the task runs on: it names itself in the prompt and in a permission request. */
    private readonly selfOrcaNodeId: OrcaNodeId,
    /** Called after every observable change of state; the runner stores the task then. */
    private readonly changed: () => void,
  ) {
    this.view = init.view;
    this.id = init.view.id;
    this.origin = init.origin;
    this.createdAt = init.view.status.timestamp;
    this.text = messageText(init.message);
    const { permission_mode: asked = "read-only" } = this.pod;
    // A task lives as long as this node allows (§6.9).
    this.ttlLeftMs = settings.task_timeout_s * 1000;
    // A task that names no mode runs read-only. The ceiling only narrows what the origin
    // asked for (§7.10); an approval widens it later (§7.12).
    this.mode = settings.permission_mode === undefined ? asked : narrowPermissionMode(settings.permission_mode, asked);
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
    this.changed();
    void this.guarded(async () => {
      const input = this.prepare();
      this.iterator = this.executor.run(input, this.abort.signal);
      this.move("working");
      await this.drive();
    });
  }

  /**
   * The origin approved the parked request: the task runs with the mode it asked
   * for until it ends (§7.12); nothing else inherits it.
   */
  grant(): void {
    if (this.request !== null) this.mode = this.request.requested_mode;
    this.proceed();
  }

  /** The origin denied the parked request. */
  deny(reason: string): void {
    this.terminate("failed", textMessage(`permission denied: ${reason}`), "permission_denied");
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
    this.changed();
  }

  /** The single exit: after this the task holds no timer or permission request. */
  private finish(state: TaskState, message: A2AMessage | undefined, reason?: string): void {
    if (this.over) return;
    this.view.status = {
      state,
      timestamp: new Date().toISOString(),
      message: message && TaskRecord.truncateMessage(message, RESULT_MAX_BYTES),
      reason,
    };
    this.clearTtl();
    this.request = null;
    this.changed();
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

  /** Back to work after an approval: the clock runs on from where it stood, then the executor loop restarts. */
  private proceed(): void {
    this.request = null;
    this.armTtl();
    this.move("working");
    void this.guarded(() => this.drive());
  }

  // ---- running ----

  /** What the origin asked for (§5.1). */
  private get pod(): PodTaskMetadata {
    return this.view.metadata?.pod ?? {};
  }

  private prepare(): ExecuteInput {
    const { settings, workspace } = this;
    const { model, reasoning_effort } = this.pod;
    return {
      contextId: this.view.contextId,
      prompt: composePrompt({
        taskId: this.id,
        selfOrcaNodeId: this.selfOrcaNodeId,
        text: this.text,
      }),
      originOrcaNode: this.origin,
      workspaceDir: workspace.root,
      podDir: workspace.state,
      permissionMode: this.mode,
      permissionCeiling: settings.permission_mode,
      model,
      // The `reasoning_effort` field, else the effort pinned in `model` (§6.15).
      reasoningEffort: reasoning_effort ?? model?.reasoningEffort,
    };
  }

  /** Feed executor events into the state machine until the task ends or parks; resuming it answers the last suspension. */
  private async drive(): Promise<void> {
    const step = await this.iterator.next();
    if (this.over) {
      await this.iterator.return();
      return;
    }
    if (step.done) {
      return this.finish("failed", textMessage("executor exited without a terminal event"), "executor_exited");
    }
    const event = step.value;
    switch (event.type) {
      case "suspend":
        return this.requestPermission(event);
      case "completed":
        return this.finish("completed", textMessage(event.text));
      case "failed":
        return this.finish("failed", textMessage(event.text), event.reason ?? "executor_error");
      default:
        return assertNever(event);
    }
  }

  /** Ask the origin to let this task continue with a wider mode (§7.12); the executor waits for the answer. */
  private requestPermission({ tool, requested, requestedMode }: Suspension): void {
    const request: PermissionRequest = {
      request_id: randomUUID(),
      task_id: this.id,
      tool,
      requested,
      requested_by: this.selfOrcaNodeId,
      current_mode: this.mode,
      requested_mode: requestedMode,
    };
    this.request = request;
    // `input-required`: the TTL stands still while the task waits, however long the human takes (§7.12).
    this.clearTtl();
    this.move("input-required", { role: "agent", parts: [{ kind: "data", data: { permission_request: request } }] });
  }

  // ---- timers ----

  /** Run the lifetime clock for what is left of it. */
  private armTtl(): void {
    this.clearTtl();
    this.ttlDeadline = Date.now() + this.ttlLeftMs;
    this.ttl = setTimeout(() => this.terminate("failed", textMessage("task ttl exceeded"), "timeout"), this.ttlLeftMs);
    this.ttl.unref();
  }

  /** Stop the lifetime clock, keeping what is left of it. */
  private clearTtl(): void {
    if (this.ttl !== null) clearTimeout(this.ttl);
    this.ttl = null;
    if (this.ttlDeadline !== null) this.ttlLeftMs = Math.max(0, this.ttlDeadline - Date.now());
    this.ttlDeadline = null;
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
