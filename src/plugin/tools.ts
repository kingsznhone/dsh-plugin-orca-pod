/**
 * The single DSH tool registered by the Orca pod bundle.
 *
 * Every operation is a method on `orca_pod` instead of a separate tool, so the
 * agent's context carries one schema rather than six. Task methods are
 * non-blocking wrappers over `OrcaNode`: `send` returns a task id immediately
 * and callers poll `status` for the result.
 */

import { z } from "zod";

import { normalizePeerUrl } from "../transport/net.ts";
import { DEFAULT_PORT } from "../protocol/constants.ts";
import { SandboxModeSchema, isPermissionMode } from "../protocol/permission.ts";
import { isTerminal, type SubmitTaskInput, type TaskState, type TaskView } from "../protocol/task.ts";
import { parseModelSpec } from "../protocol/model.ts";
import type { PeerView } from "../protocol/peer.ts";
import { describeIssue, parseSchema } from "../kernel/schema.ts";
import { runningInTask } from "../kernel/entry.ts";
import { errorMessage, PodError } from "../kernel/errors.ts";
import type { OrcaNode } from "../node/orca-node.ts";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import type { JsonSchemaNode, ToolDefinition, ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { PodHandle } from "./lifecycle.ts";
import type { Tracker } from "./tracker.ts";

/** The sandbox-policy read `sessionSandboxMode` needs; the host service satisfies it. */
export type SandboxReader = Pick<SandboxPolicyService, "resolve">;

const ASYNC_NOTE =
  'Tasks run asynchronously on the remote orca node: method "send" returns as soon as the remote accepts the task, and method "status" observes the returned task_id.';

const METHODS_HELP =
  "Methods: " +
  "send (peer, text; optional echo, permission_mode, model, reasoning_effort) dispatches a task; " +
  "status (peer, task_id) reads one task; " +
  "cancel (peer, task_id) requests cancellation; " +
  "members (no arguments) lists this node and its peers; " +
  `connect (peer; bare host or host:port defaults to ${DEFAULT_PORT}) joins a peer into the mesh.`;

/**
 * Output values differ per method (send/status/cancel return task views,
 * members returns a roster), so the canonical output schema is the unconstrained
 * JSON form. The executor accepts an annotation-only schema for exactly this case.
 */
const OUTPUT_SCHEMA: JsonSchemaNode = { description: "JSON payload rendered as text." };

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

// ---- what a call carries ----

const Text = z.string("must be a non-empty string").trim().min(1, "must be a non-empty string");

const PeerArgs = z.object({ peer: Text });
const TaskArgs = PeerArgs.extend({ task_id: Text });
const SendArgs = PeerArgs.extend({
  text: Text,
  echo: z.record(z.string(), z.unknown(), "must be an object holding a deterministic echo script").optional(),
  permission_mode: SandboxModeSchema.optional(),
  model: z.string("must be a provider/model string").optional(),
  // A value that is not text means "no effort"; a blank one is refused.
  reasoning_effort: z.preprocess((value) => (typeof value === "string" ? value : undefined), Text.optional()),
});

const METHOD_NAMES = ["send", "status", "cancel", "members", "connect"] as const;

/** `method` is checked first, so its error names the choices. */
const MethodSchema = z.object({
  method: z.enum(METHOD_NAMES, `must be one of ${METHOD_NAMES.map((name) => `"${name}"`).join(", ")}`),
});

/** One call of the tool: its method and the arguments that method takes. */
type PodCall =
  | { method: "send"; args: z.output<typeof SendArgs> }
  | { method: "status" | "cancel"; args: z.output<typeof TaskArgs> }
  | { method: "connect"; args: z.output<typeof PeerArgs> }
  | { method: "members" };

function parseArgs<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = parseSchema(schema, raw);
  if (!parsed.ok) throw new Error(describeIssue(parsed.issue));
  return parsed.value;
}

function parseCall(raw: unknown): PodCall {
  const { method } = parseArgs(MethodSchema, raw);
  switch (method) {
    case "send":
      return { method, args: parseArgs(SendArgs, raw) };
    case "status":
    case "cancel":
      return { method, args: parseArgs(TaskArgs, raw) };
    case "connect":
      return { method, args: parseArgs(PeerArgs, raw) };
    case "members":
      return { method };
  }
}

// ---- what a call answers ----

/** A node as `members` and `connect` list it. */
type PeerSummary = Pick<
  PeerView,
  "orca_node_id" | "display_name" | "endpoints" | "state" | "busy" | "runtime" | "last_recv_at" | "max_task_ttl_s"
>;

type SendResult = { task_id: string; state: TaskState; peer: string };
type TaskStatusResult = TaskView & { terminal: boolean };
type ConnectResult = { peer: string; members: PeerSummary[]; members_digest: string };
type MembersResult = { self: PeerSummary } & Omit<ConnectResult, "peer">;

const taskStatus = (view: TaskView): TaskStatusResult => ({ ...view, terminal: isTerminal(view.status.state) });

/** Wait for startup, then fail the tool call when the orca node is not usable. */
async function requireNode(handle: PodHandle): Promise<OrcaNode> {
  await handle.ready;
  if (handle.runtime.error !== null) {
    throw new Error(`orca node is not running: ${handle.runtime.error.message}`);
  }
  const orcaNode = handle.runtime.orcaNode;
  if (orcaNode === null) {
    throw new Error("orca node is not running");
  }
  return orcaNode;
}

function peerSummary(peer: PeerView): PeerSummary {
  return {
    orca_node_id: peer.orca_node_id,
    display_name: peer.display_name,
    endpoints: peer.endpoints,
    state: peer.state,
    busy: peer.busy,
    runtime: peer.runtime,
    last_recv_at: peer.last_recv_at,
    max_task_ttl_s: peer.max_task_ttl_s,
  };
}

/**
 * The dispatching session's sandbox mode (`ctx.sandboxPolicy` resolves it, and
 * its `SandboxMode` values match the orca node permission modes, so a task
 * inherits the session setting verbatim). Without the service or a session the
 * target's own default (read-only) applies.
 */
export function sessionSandboxMode(
  policy: SandboxReader | undefined,
  exec: ToolExecution | undefined,
): SandboxMode | undefined {
  const session = exec?.agent?.session;
  if (policy === undefined || session === undefined) return undefined;
  const mode = policy.resolve({ session }).mode;
  return isPermissionMode(mode) ? mode : undefined;
}

async function runSend(
  handle: PodHandle,
  tracker: Tracker,
  args: z.output<typeof SendArgs>,
  exec: ToolRunContext | undefined,
  policy: SandboxReader | undefined,
): Promise<SendResult> {
  // Tasks are single-hop: a session the task executor spawned never dispatches (§7.9).
  if (runningInTask()) {
    throw new Error(
      "send is not available inside a task: tasks are single-hop; end the task with a BLOCKED: report instead",
    );
  }
  const signal = exec?.signal;
  const peer = normalizePeerUrl(args.peer);
  const permissionMode = args.permission_mode ?? sessionSandboxMode(policy, exec);
  const model = args.model === undefined ? undefined : (parseModelSpec(args.model, args.reasoning_effort) ?? undefined);
  if (args.model !== undefined && model === undefined) {
    throw new Error("model must be a provider/model string");
  }
  const orcaNode = await requireNode(handle);
  const input: SubmitTaskInput = {
    message: { role: "user", parts: [{ kind: "text", text: args.text }] },
    metadata: {
      echo: args.echo,
      pod: {
        permission_mode: permissionMode,
        model,
        reasoning_effort: model === undefined ? args.reasoning_effort : undefined,
      },
    },
  };
  throwIfAborted(signal);
  const view = await orcaNode.sendTask(peer, input, signal === undefined ? {} : { signal });
  if (signal?.aborted === true) {
    // The remote accepted the task after the caller's turn was cancelled: the
    // caller never learns its id, so it must not keep running unobserved.
    // Best effort; the dispatch log still lists it for the panel.
    orcaNode.cancelTask(peer, view.id).catch(() => {});
    throw abortError();
  }
  // Track the task so the dispatching agent is told when it finishes, even
  // after its turn ends.
  if (exec?.agent !== undefined) tracker.track(exec.agent, peer, view.id);
  return { task_id: view.id, state: view.status.state, peer };
}

async function runStatus(
  handle: PodHandle,
  args: z.output<typeof TaskArgs>,
  signal?: AbortSignal,
): Promise<TaskStatusResult> {
  const orcaNode = await requireNode(handle);
  return taskStatus(
    await orcaNode.getTask(normalizePeerUrl(args.peer), args.task_id, signal === undefined ? {} : { signal }),
  );
}

async function runCancel(
  handle: PodHandle,
  args: z.output<typeof TaskArgs>,
  signal?: AbortSignal,
): Promise<TaskStatusResult> {
  const orcaNode = await requireNode(handle);
  return taskStatus(
    await orcaNode.cancelTask(normalizePeerUrl(args.peer), args.task_id, signal === undefined ? {} : { signal }),
  );
}

async function runMembers(handle: PodHandle): Promise<MembersResult> {
  const orcaNode = await requireNode(handle);
  return {
    self: peerSummary(orcaNode.self()),
    members: orcaNode.members().map(peerSummary),
    members_digest: orcaNode.membersDigest(),
  };
}

async function runConnect(
  handle: PodHandle,
  args: z.output<typeof PeerArgs>,
  signal?: AbortSignal,
): Promise<ConnectResult> {
  const peer = normalizePeerUrl(args.peer);
  await requireNode(handle);
  // Joining persists the peer; do not start it for a turn that is already gone.
  throwIfAborted(signal);
  await handle.addPeer(peer);
  const orcaNode = await requireNode(handle);
  return {
    peer,
    members: orcaNode.members().map(peerSummary),
    members_digest: orcaNode.membersDigest(),
  };
}

/** Rejection used when the caller's turn is cancelled mid-call. */
function abortError(): Error {
  const error = new Error("cancelled by the caller");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError();
}

/**
 * Race one method against the caller's abort signal, so a cancelled turn stops
 * waiting (for node startup, the panel queue, a slow peer). This only ends the
 * wait; the methods forward the same signal to their outbound requests and
 * check it before any step with a lasting effect.
 */
function withSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    // Nobody waits for the abandoned work any more; keep its rejection handled.
    work.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Wrap an error with the operation that failed, keeping the pod error code (and
 * its status) when the failure came from a pod call.
 */
export function describeError(operation: string, error: unknown): Error {
  if (error instanceof PodError) {
    return new PodError(error.code, `${operation} [${error.code}]: ${error.message}`, error.status);
  }
  return new Error(`${operation}: ${errorMessage(error)}`);
}

/** Dispatch one `orca_pod` call against the running node. */
function runCall(
  handle: PodHandle,
  tracker: Tracker,
  call: PodCall,
  exec: ToolRunContext | undefined,
  policy: SandboxReader | undefined,
): Promise<SendResult | TaskStatusResult | MembersResult | ConnectResult> {
  switch (call.method) {
    case "send":
      return runSend(handle, tracker, call.args, exec, policy);
    case "status":
      return runStatus(handle, call.args, exec?.signal);
    case "cancel":
      return runCancel(handle, call.args, exec?.signal);
    case "members":
      return runMembers(handle);
    case "connect":
      return runConnect(handle, call.args, exec?.signal);
  }
}

/** Build the single `orca_pod` tool definition bound to one running pod handle. */
export function createPodTools(
  handle: PodHandle,
  tracker: Tracker,
  policy?: () => SandboxReader | undefined,
): ToolDefinition[] {
  const tool: ToolDefinition = {
    name: "orca_pod",
    description:
      "Operate the Orca Pod mesh from this session: dispatch and inspect tasks on other orca nodes, list members, or join a new peer. " +
      METHODS_HELP +
      " " +
      ASYNC_NOTE,
    parameters: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: [...METHOD_NAMES],
          description: "Operation to perform. See the tool description for each method's arguments.",
        },
        peer: {
          type: "string",
          description: `Target peer: http://host:port, host:port, or a bare host (port defaults to ${DEFAULT_PORT}). Required by send, status, cancel and connect.`,
        },
        text: { type: "string", description: "send: task text sent as an A2A user message part." },
        task_id: { type: "string", description: 'status/cancel: task id returned by method "send".' },
        echo: {
          type: "object",
          description:
            "send: optional deterministic echo script forwarded as metadata.echo for tests: " +
            "{steps:[{at_ms,suspend:{kind,reason|tool,...}}],final:{state,text},artifacts:[{name,content}]}.",
          additionalProperties: true,
        },
        permission_mode: {
          type: "string",
          enum: [...SandboxModeSchema.options],
          description:
            "send: explicit permission mode; when omitted the dispatching session's sandbox mode is inherited. The target caps it by its own policy and never runs above it.",
        },
        model: {
          type: "string",
          description:
            "send: optional model for the target task as provider/model. The target must advertise it and run the ACP executor.",
        },
        reasoning_effort: {
          type: "string",
          description: "send: optional reasoning effort for the selected model; only meaningful together with model.",
        },
      },
      required: ["method"],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec: ToolRunContext | undefined) {
      const call = parseCall(args);
      try {
        throwIfAborted(exec?.signal);
        return await withSignal(runCall(handle, tracker, call, exec, policy?.()), exec?.signal);
      } catch (error) {
        throw describeError("orca_pod", error);
      }
    },
  };
  return [tool];
}
