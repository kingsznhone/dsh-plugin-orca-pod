/** A2A task surface (§4.7, §4.8, §5.1). */

import type { SessionId } from "@deepseek-ai/dsh-session";
import { type PRNG, ulid } from "ulid";
import { z } from "zod";

import { PermissionRequestSchema, type PermissionRequest, type ResumeControl } from "../core/wire/grant.ts";
import { ModelSelectionSchema, ReasoningEffortSchema } from "../core/wire/model.ts";
import { SandboxModeSchema } from "../core/wire/permission.ts";
import { OrcaNodeIdSchema } from "../core/wire/peer.ts";

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
 * accepted (`task/meta.ts`). A task is always single-hop: an agent running a
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

// ---- JSON-RPC (§4.7) ----

/** The A2A JSON-RPC surface (§4.7). */

const TaskIdParams = z.looseObject({ id: z.string() });

/**
 * Parameters per method. The caller builds them against `z.input` of these
 * schemas and the gateway parses with the same ones, so both sides name the
 * same shape. Every method answers with a task view.
 */
export const A2A_PARAMS = {
  "message/send": z.looseObject({ message: A2AMessageSchema, metadata: TaskMetadataSchema.optional() }),
  "tasks/get": TaskIdParams,
  "tasks/cancel": TaskIdParams,
};
export type A2AMethod = keyof typeof A2A_PARAMS;
export type A2AParams<M extends A2AMethod> = z.input<(typeof A2A_PARAMS)[M]>;

export function isA2AMethod(method: string): method is A2AMethod {
  return Object.hasOwn(A2A_PARAMS, method);
}

/** The JSON-RPC request envelope; `params` is checked per method. */
export const RpcRequestSchema = z.object({
  id: z.unknown().optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

/** The success envelope of an A2A call. */
export const RpcResultSchema = z.object({ result: TaskViewSchema });

// ---- dispatch log entries (§8.3) ----

/** What an origin remembers about a task it handed to a peer (§8.3). */

export type DispatchEntry = {
  /** Task id returned by the target. */
  task_id: string;
  /** Target endpoint the task was dispatched to. */
  peer: string;
  context_id?: string;
  /** Last observed task state; `unknown` once a restart cut the origin off from it. */
  state: TaskState | "unknown";
  last_error?: string;
  /**
   * DSH session that dispatched the task (§8.3). Persisted so the host can
   * resume background tracking after a restart, when the in-memory tracker is
   * empty but the remote task may still be running.
   */
  agent_id?: SessionId;
  created_at: string;
  updated_at: string;
};

// ---- events an in-process listener hears about (§9.2) ----

/** A task this node runs changed. */
export type TaskEvent = { type: "task"; view: TaskView };

/** An entry of this node's dispatch log changed. */
export type DispatchEvent = { type: "dispatch"; entry: DispatchEntry };
