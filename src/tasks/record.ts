/**
 * One task on this node and its state machine (§4.8, §6.9):
 *
 *   submitted -> working <-> input-required -> completed | failed | canceled
 *
 * Every transition goes through `move` (live states) or `finish` (the single
 * exit, which also releases everything the task holds). The executor loop,
 * the permission wait (§7.11, §7.12) and the timers all live here; the slot,
 * the store and lookups belong to the task runner (`runner.ts`).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { checkGrant, type GrantLedger } from "../security/grants.ts";
import type { FileBlobRegistry, TaskStore } from "../storage/stores.ts";
import { assertNever, errorMessage, PodError } from "../kernel/errors.ts";
import type { NodeLogger } from "../kernel/events.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor } from "../execution/executor.ts";
import {
  isTerminal,
  messageText,
  textMessage,
  type A2AMessage,
  type TaskState,
  type TaskView,
} from "../protocol/task.ts";
import { narrowPermissionMode } from "../protocol/permission.ts";
import type { PermissionRequest, RequestedAccess } from "../protocol/grant.ts";
import { composePrompt, listNotes } from "./prompt.ts";
import { parseResume, type TaskMeta } from "./meta.ts";
import type { Workspace } from "./workspace.ts";
import type { OrcaNodeId, WorkgroupId } from "../protocol/peer.ts";

/** What a record needs from the node and the task runner. */
export type RecordHost = {
  executor: LocalExecutor;
  /** Where the files a task produces are published (§5.6). */
  fileBlobs: FileBlobRegistry;
  workspace: Workspace;
  store: TaskStore;
  ledger: GrantLedger;
  logger: NodeLogger;
  selfOrcaNodeId: OrcaNodeId;
  workgroupId: WorkgroupId;
  dataRoot: string;
  /** Local ceiling for the inherited mode; unset means the origin's mode applies as is (§7.10). */
  permissionMode: SandboxMode | undefined;
  /** Auto-reject a parked request after this many seconds; unset waits forever (§7.12). */
  permissionTtlS: number | undefined;
  /** Inline result summary cap in bytes (§6.11). */
  resultMaxBytes: number;
  /** The task runner's single slot (§6.9). */
  claim(taskId: string): void;
  release(taskId: string): void;
  /** The record is terminal and persisted: stop tracking it in memory. */
  drop(taskId: string): void;
  onEvent(view: TaskView): void;
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
  private readonly host: RecordHost;
  private readonly ttlS: number;
  private readonly text: string;
  private readonly abort = new AbortController();
  private readonly mode: SandboxMode;
  /** The executor run; created by `begin()` before the first `drive()`. */
  private iterator!: AsyncGenerator<ExecutorEvent, void, void>;
  private ttl: NodeJS.Timeout | null = null;
  private permissionTimer: NodeJS.Timeout | null = null;
  /** The permission request this task is parked on, if any. */
  private wait: PermissionRequest | null = null;

  constructor(host: RecordHost, init: RecordInit) {
    this.host = host;
    this.view = init.view;
    this.id = init.view.id;
    this.origin = init.origin;
    this.createdAt = init.view.status.timestamp;
    this.meta = init.meta;
    this.ttlS = init.ttlS;
    this.text = init.text;
    // Resolved once: the ceiling only narrows what the origin asked for (§7.10).
    this.mode =
      host.permissionMode === undefined
        ? init.meta.permissionMode
        : narrowPermissionMode(host.permissionMode, init.meta.permissionMode);
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
    this.host.onEvent(this.snapshot());
    void this.guarded(async () => {
      const input = await this.prepare();
      if (this.over) return;
      this.iterator = this.host.executor.run(input, this.abort.signal);
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
        selfOrcaNodeId: this.host.selfOrcaNodeId,
        workgroupId: this.host.workgroupId,
        origin: this.origin,
        pending: wait,
      },
      this.host.ledger,
    );
    if (failure !== null) {
      this.terminate("failed", textMessage(`permission grant rejected: ${failure}`), failure);
      return;
    }
    this.host.ledger.consume(control.grant);
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
    this.host.onEvent(this.snapshot());
  }

  /** The single exit: after this the task holds no timer, slot, directory or live entry. */
  private finish(state: TaskState, message: A2AMessage | undefined, reason?: string): void {
    if (this.over) return;
    this.view.status = {
      state,
      timestamp: nowIso(),
      message: message && truncateMessage(message, this.host.resultMaxBytes),
      reason,
    };
    this.clearTtl();
    this.clearPermissionTimer();
    this.wait = null;
    this.host.release(this.id);
    this.persist();
    this.host.onEvent(this.snapshot());
    this.host.drop(this.id);
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
    this.host.claim(this.id);
    this.move("working");
    void this.guarded(() => this.drive());
  }

  // ---- running ----

  private async prepare(): Promise<ExecuteInput> {
    const { host, meta } = this;
    const notes = await listNotes(host.workspace.notes);
    return {
      taskId: this.id,
      contextId: this.view.contextId,
      prompt: composePrompt({
        taskId: this.id,
        selfOrcaNodeId: host.selfOrcaNodeId,
        dataRoot: host.dataRoot,
        text: this.text,
        notes,
      }),
      originOrcaNode: this.origin,
      selfOrcaNodeId: host.selfOrcaNodeId,
      workspaceDir: host.workspace.root,
      podDir: host.workspace.state,
      permissionMode: this.mode,
      model: meta.model,
      reasoningEffort: meta.effort,
      echo: meta.echo,
    };
  }

  /** Feed executor events into the state machine until the task ends or parks. */
  private async drive(): Promise<void> {
    for (;;) {
      const step = await this.iterator.next();
      if (this.over) {
        await this.iterator.return();
        return;
      }
      if (step.done)
        return this.finish("failed", textMessage("executor exited without a terminal event"), "executor_exited");
      const event = step.value;
      switch (event.type) {
        case "suspend":
          return this.requestPermission(event.suspend.tool, event.suspend.requested);
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
    const dir = join(this.host.workspace.state, "artifacts", this.id);
    const path = join(dir, String((this.view.artifacts ?? []).length + 1));
    await mkdir(dir, { recursive: true });
    await writeFile(path, content, "utf8");
    const blob = await this.host.fileBlobs.register(path);
    if (this.over) return;
    this.view.artifacts = [
      ...(this.view.artifacts ?? []),
      { artifactId: blob.blob_id, name, mediaType: "text/plain", bytes: blob.size },
    ];
    this.persist();
    this.host.onEvent(this.snapshot());
  }

  /** Ask the origin to decide on one tool (§7.11); the executor waits for the answer. */
  private requestPermission(tool: string, requested: RequestedAccess): void {
    const ttlS = this.host.permissionTtlS;
    const request: PermissionRequest = {
      request_id: randomUUID(),
      task_id: this.id,
      tool,
      requested,
      requested_by: this.host.selfOrcaNodeId,
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
    this.host.release(this.id);
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
    const ttlS = this.host.permissionTtlS;
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
      this.host.store.save({
        view: this.view,
        origin_orca_node: this.origin,
        created_at: this.createdAt,
        updated_at: nowIso(),
      }),
    );
  }

  /**
   * Housekeeping must not take the node down or strand a live task: a failing
   * disk is logged, and the task stays readable from memory (leftover input
   * directories are purged at the next start).
   */
  private attempt(problem: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      this.host.logger.warn(`task ${this.id}: ${problem}: ${errorMessage(error)}`);
    }
  }
}
