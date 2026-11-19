/** A2A task surface (§4.7, §4.8, §5.1). */

import type { SessionId } from "@deepseek-ai/dsh-session";
import { z } from "zod";

import { ModelSelectionSchema, ReasoningEffortSchema } from "../executor/model.ts";
import { SandboxModeSchema } from "../executor/permission.ts";
import { OrcaNodeIdSchema, WorkgroupIdSchema, type OrcaNodeId } from "../core/ids.ts";
import { RequestedAccessSchema } from "../executor/executor.ts";

// ---- permission requests and grants (§7.11, §7.12) ----

const Text = z.string().min(1, "must be a non-empty string");

/**
 * A suspended task's ask to run with a wider permission mode (§7.11, §7.12):
 * one tool call needed more than `current_mode` allows, and `requested_mode` is
 * the narrowest mode that covers it. It lives in `status.message`, so the origin
 * discovers it by reading task state; nothing is pushed to it.
 */
export const PermissionRequestSchema = z.object({
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
  /** Present only when the executing orca node configures an approval timeout (§7.12). */
  expires_at: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

/**
 * A human decision travelling from the origin back down to the target (§7.11):
 * the task may continue with `permission_mode` until it ends. Signed by the
 * origin node's Ed25519 key: the transport is already authenticated, but a
 * grant is also the durable record of who allowed what.
 */
const GrantSchema = z.object({
  grant_id: Text,
  workgroup_id: WorkgroupIdSchema,
  /** Orca node whose signature authorizes this grant (the deciding origin). */
  origin_orca_node: OrcaNodeIdSchema,
  task_id: Text,
  target_orca_node: OrcaNodeIdSchema,
  tool: Text,
  /** The mode the task runs with from now on; it is the request's `requested_mode`. */
  permission_mode: SandboxModeSchema,
  /** The permission request this grant answers. */
  request_id: Text,
  issued_at: Text,
  expires_at: Text.refine((value) => !Number.isNaN(Date.parse(value)), "must be a date"),
});
export type Grant = z.infer<typeof GrantSchema>;

export const SignedGrantSchema = GrantSchema.extend({ sig: Text });
export type SignedGrant = z.infer<typeof SignedGrantSchema>;

/**
 * What the origin sends back to a suspended task (§7.11): a signed grant, or a
 * refusal. The sender builds this shape; the receiving task checks the grant
 * with `SignedGrantSchema` before it acts on it.
 */
export type ResumeControl = { grant: SignedGrant } | { permission_denied: true; reason: string };

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
 * read, so a newer peer's extras survive; the kinds themselves are closed.
 */
const MessagePartSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("text"), text: z.string() }),
  z.looseObject({ kind: z.literal("data"), data: z.record(z.string(), z.unknown()) }),
  z.looseObject({
    kind: z.literal("file"),
    file: z.looseObject({ name: z.string(), mimeType: z.string().optional(), bytes: z.string().optional() }),
  }),
]);

const A2AMessageSchema = z.looseObject({
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
const PodTaskMetadataSchema = z.looseObject({
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
  task_ttl_s: z.number("must be a positive number").positive("must be a positive number").optional(),
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

const TaskViewSchema = z.object({
  kind: z.literal("task"),
  id: z.string(),
  contextId: z.string(),
  status: TaskStatusSchema,
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

// ---- JSON-RPC (§4.7) ----

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

// ---- dispatch log entries (§8.3) ----

/** What an origin remembers about a task it handed to a peer (§8.3). */
export type DispatchEntry = {
  /** Task id returned by the target. */
  task_id: string;
  /** The node the task was dispatched to. */
  node: OrcaNodeId;
  context_id?: string;
  /** Last observed task state; `unknown` once a restart cut the origin off from it. */
  state: TaskState | "unknown";
  last_error?: string;
  /**
   * DSH session that dispatched the task (§8.3): where the tracker sends the
   * notice when the task ends, if that session is open then.
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

/** The task holding a node's single slot (§6.9). */
export const BusyStateSchema = z.object({
  task_id: z.string(),
  origin_orca_node: OrcaNodeIdSchema,
  since: z.string(),
});
export type BusyState = z.infer<typeof BusyStateSchema>;
