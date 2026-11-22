/** A2A task surface (design.md 3.5, 3.6, 4.1). */

import type { SessionId } from "@deepseek-ai/dsh-session";
import { z } from "zod";

import { ModelSelectionSchema, ReasoningEffortSchema } from "../executor/model.ts";
import { SandboxModeSchema } from "../executor/permission.ts";
import { OrcaNodeIdSchema, type OrcaNodeId } from "../core/ids.ts";
import { RequestedAccessSchema } from "../executor/executor.ts";

// ---- permission requests and decisions (design.md 6.4) ----

/**
 * A suspended task's ask to run with a wider permission mode (design.md 6.4):
 * one tool call needed more than `current_mode` allows, and `requested_mode` is
 * the narrowest mode that covers it. It lives in `status.message`, so the origin
 * discovers it by reading task state; nothing is pushed to it.
 */
const PermissionRequestSchema = z.object({
  request_id: z.string(),
  task_id: z.string(),
  tool: z.string(),
  requested: RequestedAccessSchema,
  /** Orca node that needs the permission (the one running the task). */
  requested_by: OrcaNodeIdSchema,
  /** The task's effective mode when it stopped. */
  current_mode: SandboxModeSchema,
  /** The mode the task asks to continue with, wider than `current_mode` and within the target's ceiling. */
  requested_mode: SandboxModeSchema,
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

/**
 * What the origin sends back to a suspended task (design.md 6.4), as the one data part
 * of a resume message: its human's approval of the request the task is parked
 * on (named by `request_id`; the task then runs with that request's
 * `requested_mode` until it ends), or a refusal. The resume request itself is
 * signed by the origin, and only the origin may resume its task. A refusal
 * wins over an approval in the same part; a reason that is not text reads as
 * the default.
 */
const ResumeControlSchema = z.union([
  z.object({ permission_denied: z.literal(true), reason: z.string().catch("denied by origin") }),
  z.object({ permission_granted: z.literal(true), request_id: z.string() }),
]);
export type ResumeControl = z.infer<typeof ResumeControlSchema>;

const TaskStateSchema = z.enum(["submitted", "working", "input-required", "completed", "failed", "canceled"]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** States in which a task can no longer change; the one definition every reader (and the dispatch store's query) uses. */
export const TERMINAL_STATES = ["completed", "failed", "canceled"] as const satisfies readonly TaskState[];

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_STATES);

export function isTerminal(state: string): boolean {
  return TERMINAL.has(state);
}

/**
 * One part of an A2A message. Loose objects keep the fields this node does not
 * read, so a newer peer's extras survive; the kinds themselves are closed. There
 * is no `file` part: files are not part of a task, its text names them (design.md 4.5).
 */
const MessagePartSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("text"), text: z.string() }),
  z.looseObject({ kind: z.literal("data"), data: z.record(z.string(), z.unknown()) }),
]);

const A2AMessageSchema = z.looseObject({
  role: z.enum(["user", "agent"]),
  parts: z.array(MessagePartSchema),
  messageId: z.string().optional(),
  /** Set when this message continues an input-required task (design.md 3.6). */
  taskId: z.string().optional(),
  contextId: z.string().optional(),
});
export type A2AMessage = z.infer<typeof A2AMessageSchema>;

/** A message of plain text from this node's side (task results and failure texts). */
export function textMessage(text: string): A2AMessage {
  return { role: "agent", parts: [{ kind: "text", text }] };
}

/** The text of a message: its text parts, joined. */
export function messageText(message: A2AMessage): string {
  return message.parts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** The decision a resume message carries (design.md 6.4); null when it carries none. */
export function resumeControlOf(message: A2AMessage): ResumeControl | null {
  for (const part of message.parts) {
    if (part.kind !== "data") continue;
    const control = ResumeControlSchema.safeParse(part.data);
    if (control.success) return control.data;
  }
  return null;
}

/**
 * The `pod` block of a task's metadata (design.md 4.1). Unknown keys are kept: another
 * node may be newer; a task's lifetime is the target's own cap, not the
 * origin's to set (design.md 5.3). A task is always single-hop: an agent running a task
 * cannot dispatch another one, so there is no delegation chain to carry.
 */
const PodTaskMetadataSchema = z.looseObject({
  /**
   * The node that dispatched the task. The target writes it into the task view
   * from the authenticated caller; whatever a caller sends is overwritten.
   */
  origin_orca_node: OrcaNodeIdSchema.optional(),
  /** Origin session mode; the run starts at this mode, and only an origin approval can widen it, bounded by the target's own ceiling (design.md 6.4). */
  permission_mode: SandboxModeSchema.optional(),
  /** Model route the target's ACP executor should select for this task (design.md 5.6). */
  model: ModelSelectionSchema.optional(),
  /** Reasoning effort override; when omitted the effort pinned in `model` applies, and the target's local default only when neither names one (design.md 5.6). */
  reasoning_effort: ReasoningEffortSchema.optional(),
});
export type PodTaskMetadata = z.infer<typeof PodTaskMetadataSchema>;

/** Task metadata on the wire: the `pod` block, and whatever else a caller attaches. */
export const TaskMetadataSchema = z.looseObject({ pod: PodTaskMetadataSchema.optional() });
export type TaskMetadata = z.infer<typeof TaskMetadataSchema>;

const TaskStatusSchema = z.object({
  state: TaskStateSchema,
  timestamp: z.string(),
  /** Suspended payload lives in `status.message`; it is task state, not a push (design.md 3.5). */
  message: A2AMessageSchema.optional(),
  reason: z.string().optional(),
});

const TaskViewSchema = z.object({
  kind: z.literal("task"),
  id: z.string(),
  contextId: z.string(),
  status: TaskStatusSchema,
  metadata: TaskMetadataSchema.optional(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

/** Read the permission request a suspended task carries, if any (design.md 6.4). */
export function permissionRequestOf(view: TaskView): PermissionRequest | null {
  for (const part of view.status.message?.parts ?? []) {
    if (part.kind !== "data") continue;
    const request = PermissionRequestSchema.safeParse(part.data.permission_request);
    if (request.success) return request.data;
  }
  return null;
}

// ---- JSON-RPC (design.md 3.5) ----

/** What every JSON-RPC request carries besides its method: the `id` the answer echoes. */
const RpcEnvelope = z.object({ id: z.unknown().optional() });
const TaskIdParams = z.looseObject({ id: z.string() });

/** What `message/send` carries: the task's message and its metadata. */
const SendParams = z.looseObject({ message: A2AMessageSchema, metadata: TaskMetadataSchema.optional() });
export type SubmitTaskInput = z.output<typeof SendParams>;

/**
 * An A2A request, one variant per method. The caller builds it against `z.input`
 * of this schema and the gateway parses it with the same one, so both sides name
 * the same shape, and `params` is typed by `method`. Every method answers with a
 * task view.
 */
export const A2ARequestSchema = z.discriminatedUnion("method", [
  RpcEnvelope.extend({ method: z.literal("message/send"), params: SendParams }),
  RpcEnvelope.extend({ method: z.literal("tasks/get"), params: TaskIdParams }),
  RpcEnvelope.extend({ method: z.literal("tasks/cancel"), params: TaskIdParams }),
]);
export type A2ARequest = z.input<typeof A2ARequestSchema>;

/** The success envelope of an A2A call. */
export const RpcResultSchema = z.object({ result: TaskViewSchema });

// ---- dispatch log entries (design.md 4.2) ----

/** What an origin remembers about a task it handed to a peer (design.md 4.2). */
export type DispatchEntry = {
  /** Task id returned by the target. */
  task_id: string;
  /** The node the task was dispatched to. */
  node: OrcaNodeId;
  /** Last observed task state; `unknown` once a restart cut the origin off from it. */
  state: TaskState | "unknown";
  last_error?: string;
  /**
   * DSH session that dispatched the task (design.md 4.2): where the tracker sends the
   * notice when the task ends, if that session is open then.
   */
  agent_id?: SessionId;
  created_at: string;
  updated_at: string;
};

/** The task holding a node's single slot (design.md 5.3). */
export const BusyStateSchema = z.object({
  task_id: z.string(),
  origin_orca_node: OrcaNodeIdSchema,
  since: z.string(),
});
export type BusyState = z.infer<typeof BusyStateSchema>;
