/** A2A task surface (§4.7, §4.8, §5.1). */

import type { PermissionRequest } from "./grant.ts";
import type { ModelSelection, ReasoningEffort } from "./model.ts";
import type { PermissionMode } from "./permission.ts";
import type { BusyState, OrcaNodeId } from "./peer.ts";

export type TaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";

/** States in which a task can no longer change; the one definition every reader uses. */
const TERMINAL_STATES: ReadonlySet<string> = new Set<TaskState>(["completed", "failed", "canceled"]);

export function isTerminal(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "data"; data: Record<string, unknown> }
  | { kind: "file"; file: { name: string; mimeType?: string; bytes?: string } };

export type A2AMessage = {
  role: "user" | "agent";
  parts: MessagePart[];
  messageId?: string;
  /** Set when this message continues an input-required task (§4.8). */
  taskId?: string;
  contextId?: string;
};

/** Suspended payload lives in `status.message`; it is task state, not a push (§4.7). */
type TaskStatus = {
  state: TaskState;
  timestamp: string;
  message?: A2AMessage;
  reason?: string;
};

type TaskArtifact = {
  artifactId: string;
  name: string;
  mediaType?: string;
  bytes: number;
};

export type TaskView = {
  kind: "task";
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: TaskArtifact[];
  metadata?: Record<string, unknown>;
};

export type PodTaskMetadata = {
  hop?: number;
  chain?: string[];
  root?: string;
  /** Origin of the whole delegation tree; propagated unchanged by child tasks (§7.11). */
  root_origin?: string;
  /** Origin session mode; the target never runs above it (§7.10). */
  permission_mode?: PermissionMode;
  /** Model route the target's ACP executor should select for this task (§6.15). */
  model?: ModelSelection;
  /** Reasoning effort override; when omitted the target's local default applies (§6.15). */
  reasoning_effort?: ReasoningEffort;
  idempotency_key?: string;
  task_ttl_s?: number;
  grant_id?: string;
  /** Blobs the target materializes under `inputs/<task_id>/` before the run (§6.7). */
  inputs?: TaskInputRef[];
};

/** A task input is a content-addressed blob the target saves under a plain file name (§6.7). */
export type TaskInputRef = { blob_id: string; name: string };

/** Read the permission request a suspended task carries, if any (§7.11). */
export function permissionRequestOf(view: TaskView): PermissionRequest | null {
  for (const part of view.status.message?.parts ?? []) {
    if (part.kind !== "data") continue;
    const request = (part.data as { permission_request?: unknown }).permission_request;
    if (typeof request === "object" && request !== null) return request as PermissionRequest;
  }
  return null;
}

export type SubmitTaskInput = {
  message: A2AMessage;
  metadata?: Record<string, unknown> & { pod?: PodTaskMetadata };
};

/** Implemented by `tasks/runner.ts` (wired with an executor in `node/`), consumed by the gateway. */
export interface TaskRunner {
  /** `originOrcaNode` is the authenticated caller; it is recorded for busy/holder reporting (§6.9). */
  submit(input: SubmitTaskInput & { originOrcaNode: OrcaNodeId }): TaskView;
  get(taskId: string): TaskView | null;
  resume(taskId: string, message: A2AMessage, callerOrcaNode?: OrcaNodeId): TaskView;
  /**
   * Suspend a running task because a child task it delegated to needs a
   * permission only this task's origin can grant (§7.12). The parent task goes
   * `input-required` with an upstream request; an approval derives a child
   * grant from the parent grant and resumes the child.
   */
  escalate(taskId: string, relay: unknown, callerOrcaNode?: OrcaNodeId): TaskView;
  cancel(taskId: string): TaskView;
  /** Origin of a known task, used by the gateway to authorize cancellation (§5.3). */
  originOf(taskId: string): OrcaNodeId | null;
  /** Currently running task (single-slot, §6.9); null when idle. */
  busy(): BusyState | null;
  /**
   * Local (inbound) tasks, newest first, for the UI task panel (§9.2). In-memory
   * records come first, then the persisted store fills the remaining budget.
   */
  list(limit?: number): TaskView[];
  /** Fail tasks that were interrupted by a restart (§8.3); returns how many. */
  recover(): number;
}
