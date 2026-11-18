/**
 * The single DSH tool registered by the Orca pod bundle.
 *
 * Every operation is a method on `orca_pod` instead of a separate tool, so the
 * agent's context carries one schema rather than five (send/status/cancel/
 * members/connect). Task methods are
 * non-blocking wrappers over `OrcaNode`: `send` returns a task id immediately
 * and callers poll `status` for the result.
 */

import { normalizePeerUrl } from "../transport/net.ts";
import { DEFAULT_PORT } from "../protocol/constants.ts";
import { isTerminal, type SubmitTaskInput, type TaskState, type TaskView } from "../protocol/task.ts";
import { parseModelSpec } from "../protocol/model.ts";
import { narrowPermissionMode } from "../protocol/permission.ts";
import type { PeerView } from "../protocol/peer.ts";
import { runningInTask } from "../kernel/entry.ts";
import { abortError, errorMessage, PodError } from "../kernel/errors.ts";
import type { OrcaNode } from "../node/orca-node.ts";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { ReasoningEffortId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { SANDBOX_MODES, type SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { snapshotJsonValue, type JsonValue } from "@deepseek-ai/dsh-util-values";
import {
  defineTool,
  type InferArgs,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolExecution,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
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

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

// ---- what a call carries ----

const METHOD_NAMES = ["send", "status", "cancel", "members", "connect"] as const;

/**
 * Every argument of every method, declared once in DSH's tool schema DSL: DSH
 * compiles it to the JSON Schema the model sees and checks types and enums
 * before `execute` runs. Which method needs which argument is checked below.
 */
const PARAMETERS = {
  method: {
    type: "string",
    enum: METHOD_NAMES,
    required: true,
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
    additionalProperties: true,
    description:
      "send: optional deterministic echo script forwarded as metadata.echo for tests: " +
      "{steps:[{at_ms,suspend:{kind,reason|tool,...}}],final:{state,text},artifacts:[{name,content}]}.",
  },
  permission_mode: {
    type: "string",
    enum: SANDBOX_MODES,
    description:
      "send: optional permission mode, no wider than this session's (the default). The target caps it by its own policy; when the task needs more it asks the user here to upgrade it.",
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
} as const satisfies ParameterSchemaSpec;

type ToolArgs = InferArgs<typeof PARAMETERS>;
type TextKey = "peer" | "text" | "task_id" | "reasoning_effort";

/** A text argument with its whitespace trimmed; blank counts as absent. */
function optional(args: ToolArgs, key: TextKey): string | undefined {
  const value = args[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** A text argument the method needs. */
function need(args: ToolArgs, key: TextKey): string {
  const value = optional(args, key);
  if (value === undefined) throw new Error(`${key} must be a non-empty string`);
  return value;
}

type PeerArgs = { peer: string };
type TaskArgs = PeerArgs & { task_id: string };
type SendArgs = PeerArgs & {
  text: string;
  echo: ToolArgs["echo"];
  permission_mode: SandboxMode | undefined;
  model: string | undefined;
  reasoning_effort: ReasoningEffortId | undefined;
};

/** One call of the tool: its method and the arguments that method takes. */
type PodCall =
  | { method: "send"; args: SendArgs }
  | { method: "status" | "cancel"; args: TaskArgs }
  | { method: "connect"; args: PeerArgs }
  | { method: "members" };

function parseCall(args: ToolArgs): PodCall {
  const { method } = args;
  switch (method) {
    case "send": {
      if (args.reasoning_effort !== undefined && optional(args, "reasoning_effort") === undefined) {
        throw new Error("reasoning_effort must not be blank");
      }
      const effort = optional(args, "reasoning_effort");
      return {
        method,
        args: {
          peer: need(args, "peer"),
          text: need(args, "text"),
          echo: args.echo,
          permission_mode: args.permission_mode,
          model: args.model,
          reasoning_effort: effort === undefined ? undefined : ReasoningEffortId(effort),
        },
      };
    }
    case "status":
    case "cancel":
      return { method, args: { peer: need(args, "peer"), task_id: need(args, "task_id") } };
    case "connect":
      return { method, args: { peer: need(args, "peer") } };
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

/**
 * Wait for startup, then fail the tool call when the orca node is not usable.
 * Startup is the host's work, not this call's, so a cancelled turn may stop
 * waiting for it right away.
 */
async function requireNode(handle: PodHandle, signal: AbortSignal): Promise<OrcaNode> {
  await waitUnlessAborted(handle.ready, signal);
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
 * inherits the session setting verbatim). Undefined without the service or a
 * session; the task then starts read-only.
 */
export function sessionSandboxMode(policy: SandboxReader | undefined, exec: ToolExecution): SandboxMode | undefined {
  const session = exec.agent?.session;
  if (policy === undefined || session === undefined) return undefined;
  return policy.resolve({ session }).mode;
}

/**
 * The mode a dispatched task starts with: the session's, or a narrower one the
 * caller names (P1). A wider one is refused: the target asks the origin for an
 * upgrade when the task needs it (§7.12). A session whose mode cannot be read
 * counts as read-only.
 */
function taskMode(explicit: SandboxMode | undefined, session: SandboxMode | undefined): SandboxMode {
  const ceiling = session ?? "read-only";
  if (explicit === undefined) return ceiling;
  if (narrowPermissionMode(ceiling, explicit) !== explicit) {
    throw new Error(
      `permission_mode ${explicit} is wider than this session's ${ceiling}; a task can only start narrower, and asks for an upgrade when it needs one`,
    );
  }
  return explicit;
}

async function runSend(
  handle: PodHandle,
  tracker: Tracker,
  args: SendArgs,
  exec: ToolRunContext,
  policy: SandboxReader | undefined,
): Promise<SendResult> {
  // Tasks are single-hop: a session the task executor spawned never dispatches (§7.9).
  if (runningInTask()) {
    throw new Error(
      "send is not available inside a task: tasks are single-hop; end the task with a BLOCKED: report instead",
    );
  }
  const { signal } = exec;
  const peer = normalizePeerUrl(args.peer);
  const permissionMode = taskMode(args.permission_mode, sessionSandboxMode(policy, exec));
  const model = args.model === undefined ? undefined : (parseModelSpec(args.model, args.reasoning_effort) ?? undefined);
  if (args.model !== undefined && model === undefined) {
    throw new Error("model must be a provider/model string");
  }
  const orcaNode = await requireNode(handle, signal);
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
  const view = await orcaNode.sendTask(peer, input, { signal });
  if (signal.aborted) {
    // The remote accepted the task after the caller's turn was cancelled: the
    // caller never learns its id, so it must not keep running unobserved.
    // Best effort; the dispatch log still lists it for the panel.
    orcaNode.cancelTask(peer, view.id).catch(() => {});
    throw abortError("cancelled by the caller");
  }
  // Track the task so the dispatching agent is told when it finishes, even
  // after its turn ends.
  if (exec.agent !== undefined) tracker.track(exec.agent, peer, view.id);
  return { task_id: view.id, state: view.status.state, peer };
}

async function runStatus(handle: PodHandle, args: TaskArgs, signal: AbortSignal): Promise<TaskStatusResult> {
  const orcaNode = await requireNode(handle, signal);
  return taskStatus(await orcaNode.getTask(normalizePeerUrl(args.peer), args.task_id, { signal }));
}

async function runCancel(handle: PodHandle, args: TaskArgs, signal: AbortSignal): Promise<TaskStatusResult> {
  const orcaNode = await requireNode(handle, signal);
  return taskStatus(await orcaNode.cancelTask(normalizePeerUrl(args.peer), args.task_id, { signal }));
}

async function runMembers(handle: PodHandle, signal: AbortSignal): Promise<MembersResult> {
  const orcaNode = await requireNode(handle, signal);
  return {
    self: peerSummary(orcaNode.self()),
    members: orcaNode.members().map(peerSummary),
    members_digest: orcaNode.membersDigest(),
  };
}

async function runConnect(handle: PodHandle, args: PeerArgs, signal: AbortSignal): Promise<ConnectResult> {
  const peer = normalizePeerUrl(args.peer);
  await requireNode(handle, signal);
  // Joining persists the peer; do not start it for a turn that is already gone.
  throwIfAborted(signal);
  await handle.addPeer(peer);
  const orcaNode = await requireNode(handle, signal);
  return {
    peer,
    members: orcaNode.members().map(peerSummary),
    members_digest: orcaNode.membersDigest(),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError("cancelled by the caller");
}

/**
 * Wait for something this call does not own (startup), or stop waiting when
 * the caller's turn is cancelled. Never wrap the call's own work in this: a
 * tool settles only after its work has stopped (dsh-tools `execute`), so the
 * methods forward the signal to their requests and finish on their own.
 */
function waitUnlessAborted<T>(wait: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError("cancelled by the caller"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError("cancelled by the caller"));
    signal.addEventListener("abort", onAbort, { once: true });
    wait.then(
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
  exec: ToolRunContext,
  policy: SandboxReader | undefined,
): Promise<SendResult | TaskStatusResult | MembersResult | ConnectResult> {
  switch (call.method) {
    case "send":
      return runSend(handle, tracker, call.args, exec, policy);
    case "status":
      return runStatus(handle, call.args, exec.signal);
    case "cancel":
      return runCancel(handle, call.args, exec.signal);
    case "members":
      return runMembers(handle, exec.signal);
    case "connect":
      return runConnect(handle, call.args, exec.signal);
  }
}

/** A result as the lossless JSON DSH stores; every method answers with data read from JSON. */
function json(value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value);
  if (snapshot === undefined) throw new Error("the result is not lossless JSON");
  return snapshot as JsonValue;
}

/** Build the single `orca_pod` tool definition bound to one running pod handle. */
export function createPodTools(
  handle: PodHandle,
  tracker: Tracker,
  policy?: () => SandboxReader | undefined,
): ToolDefinition[] {
  const tool = defineTool({
    name: "orca_pod",
    description:
      "Operate the Orca Pod mesh from this session: dispatch and inspect tasks on other orca nodes, list members, or join a new peer. " +
      METHODS_HELP +
      " " +
      ASYNC_NOTE,
    parameters: PARAMETERS,
    // Output differs per method (task views, a roster): unconstrained JSON.
    output: { schema: { type: "json", description: "JSON payload rendered as text." }, render: renderJson },
    async execute(args, exec) {
      const call = parseCall(args);
      try {
        throwIfAborted(exec.signal);
        // The call's own work observes the signal and settles when it stops (B20).
        return json(await runCall(handle, tracker, call, exec, policy?.()));
      } catch (error) {
        throw describeError("orca_pod", error);
      }
    },
  });
  return [tool];
}
