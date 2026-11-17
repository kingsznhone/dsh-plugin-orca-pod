/** A2A task surface (§4.7, §4.8, §5.1). */

import { type PRNG, ulid } from "ulid";
import { z } from "zod";

import { PermissionRequestSchema, type PermissionRequest, type ResumeControl } from "./grant.ts";
import { ModelSelectionSchema, ReasoningEffortSchema } from "./model.ts";
import { SandboxModeSchema } from "./permission.ts";
import { OrcaNodeIdSchema, type BusyState, type OrcaNodeId } from "./peer.ts";

/**
 * Task id: a ULID (48-bit millisecond timestamp + 80 random bits, Crockford base32).
 * Time-ordered, 26 chars, unguessable enough to act as a capability handle (§5.5).
 * The `ulid` package draws the random part from `crypto.getRandomValues`; `prng`
 * exists only so tests can pin it.
 */
export function newTaskId(now: number = Date.now(), prng?: PRNG): string {
  return ulid(now, prng);
}

export const TaskStateSchema = z.enum(["submitted", "working", "input-required", "completed", "failed", "canceled"]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** States in which a task can no longer change; the one definition every reader uses. */
const TERMINAL_STATES: ReadonlySet<string> = new Set<TaskState>(["completed", "failed", "canceled"]);

export function isTerminal(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * One part of an A2A message. Loose objects keep the fields this node does not
 * read, so a newer peer's extras survive; the kinds themselves are closed.
 */
export const MessagePartSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("text"), text: z.string() }),
  z.looseObject({ kind: z.literal("data"), data: z.record(z.string(), z.unknown()) }),
  z.looseObject({
    kind: z.literal("file"),
    file: z.looseObject({ name: z.string(), mimeType: z.string().optional(), bytes: z.string().optional() }),
  }),
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const A2AMessageSchema = z.looseObject({
  role: z.enum(["user", "agent"]),
  parts: z.array(MessagePartSchema),
  messageId: z.string().optional(),
  /** Set when this message continues an input-required task (§4.8). */
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

/** A control message answering a suspended task: one data part, addressed by task id. */
export function controlMessage(taskId: string, control: ResumeControl, messageId: string): A2AMessage {
  return { role: "user", parts: [{ kind: "data", data: { ...control } }], taskId, messageId };
}

/**
 * The `pod` block of a task's metadata (§5.1). Unknown keys are kept: another
 * node may be newer. The task lifetime is narrowed further where the task is
 * accepted (`tasks/meta.ts`). A task is always single-hop: an agent running a
 * task cannot dispatch another one, so there is no delegation chain to carry.
 */
export const PodTaskMetadataSchema = z.looseObject({
  /**
   * The node that dispatched the task. The target writes it into the task view
   * from the authenticated caller; whatever a caller sends is overwritten.
   */
  origin_orca_node: OrcaNodeIdSchema.optional(),
  /** Origin session mode; the target never runs above it (§7.10). */
  permission_mode: SandboxModeSchema.optional(),
  /** Model route the target's ACP executor should select for this task (§6.15). */
  model: ModelSelectionSchema.optional(),
  /** Reasoning effort override; when omitted the target's local default applies (§6.15). */
  reasoning_effort: ReasoningEffortSchema.optional(),
  idempotency_key: z.string().optional(),
  task_ttl_s: z.number("must be a positive number").finite().positive("must be a positive number").optional(),
});
export type PodTaskMetadata = z.infer<typeof PodTaskMetadataSchema>;

/**
 * Task metadata on the wire: the `pod` block, an echo script (checked by the
 * echo executor's own parser), and whatever else a caller attaches.
 */
export const TaskMetadataSchema = z.looseObject({
  pod: PodTaskMetadataSchema.optional(),
  echo: z.unknown().optional(),
});
export type TaskMetadata = z.infer<typeof TaskMetadataSchema>;

const TaskStatusSchema = z.object({
  state: TaskStateSchema,
  timestamp: z.string(),
  /** Suspended payload lives in `status.message`; it is task state, not a push (§4.7). */
  message: A2AMessageSchema.optional(),
  reason: z.string().optional(),
});

const TaskArtifactSchema = z.object({
  artifactId: z.string(),
  name: z.string(),
  mediaType: z.string().optional(),
  bytes: z.number(),
});

export const TaskViewSchema = z.object({
  kind: z.literal("task"),
  id: z.string(),
  contextId: z.string(),
  status: TaskStatusSchema,
  artifacts: z.array(TaskArtifactSchema).optional(),
  metadata: TaskMetadataSchema.optional(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

/** Read the permission request a suspended task carries, if any (§7.11). */
export function permissionRequestOf(view: TaskView): PermissionRequest | null {
  for (const part of view.status.message?.parts ?? []) {
    if (part.kind !== "data") continue;
    const request = PermissionRequestSchema.safeParse(part.data.permission_request);
    if (request.success) return request.data;
  }
  return null;
}

export type SubmitTaskInput = {
  message: A2AMessage;
  metadata?: TaskMetadata;
};

/** Implemented by `tasks/runner.ts` (wired with an executor in `node/`), consumed by the gateway. */
export interface TaskRunner {
  /** `originOrcaNode` is the authenticated caller; it is recorded for busy/holder reporting (§6.9). */
  submit(input: SubmitTaskInput & { originOrcaNode: OrcaNodeId }): TaskView;
  get(taskId: string): TaskView | null;
  resume(taskId: string, message: A2AMessage, callerOrcaNode?: OrcaNodeId): TaskView;
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
