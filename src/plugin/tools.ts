/**
 * The single DSH tool registered by the Orca pod bundle.
 *
 * Every operation is a method on `orca_pod` instead of a separate tool, so the
 * agent's context carries one schema rather than six. Task methods are
 * non-blocking wrappers over `OrcaNode`: `send` returns a task id immediately
 * and callers poll `status` for the result.
 */

import { normalizePeerUrl } from "../net.ts";
import { DEFAULT_PORT, isPermissionMode, isRecord, isTerminal, parseModelSpec } from "../protocol.ts";
import type { PeerView, PermissionMode, SubmitTaskInput } from "../protocol.ts";
import type { OrcaNode } from "../orca_node.ts";

import type { ContentBlock, PermissionPresetsService, RawJsonSchema, ToolDefinition, ToolExecution } from "./dsh.ts";
import type { PodHandle } from "./lifecycle.ts";
import type { Tracker } from "./tracker.ts";
import { describeError } from "./util.ts";

const METHOD_NAMES = ["send", "status", "cancel", "members", "connect"] as const;
type PodMethod = (typeof METHOD_NAMES)[number];

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
const OUTPUT_SCHEMA: RawJsonSchema = { description: "JSON payload rendered as text." };

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function asRecord(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) throw new Error("tool arguments must be an object");
  return args;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function methodOf(args: Record<string, unknown>): PodMethod {
  const value = requiredString(args, "method");
  if (!(METHOD_NAMES as readonly string[]).includes(value)) {
    throw new Error(`method must be one of ${METHOD_NAMES.map((name) => `"${name}"`).join(", ")}`);
  }
  return value as PodMethod;
}

function optionalEchoScript(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = args.echo;
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("echo must be an object holding a deterministic echo script");
  return value;
}

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

function peerSummary(peer: PeerView): Record<string, unknown> {
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
 * The dispatching session's sandbox mode. DSH's permission presets project a
 * `SandboxMode` whose values match the orca node permission modes, so a task
 * inherits the session setting verbatim; without a service or session the
 * target's own default (read-only) applies.
 */
export function sessionSandboxMode(
  presets: PermissionPresetsService | undefined,
  exec: ToolExecution | undefined,
): PermissionMode | undefined {
  const session = exec?.agent?.session;
  if (presets === undefined || session === undefined) return undefined;
  const sandbox = presets.permissionState(session).sandbox;
  return isPermissionMode(sandbox) ? sandbox : undefined;
}

async function runSend(
  handle: PodHandle,
  tracker: Tracker,
  args: Record<string, unknown>,
  exec: ToolExecution | undefined,
  presets: PermissionPresetsService | undefined,
): Promise<unknown> {
  const peer = normalizePeerUrl(requiredString(args, "peer"));
  const text = requiredString(args, "text");
  const echo = optionalEchoScript(args);
  const explicitMode = args.permission_mode;
  if (explicitMode !== undefined && !isPermissionMode(explicitMode)) {
    throw new Error("permission_mode must be read-only, workspace-write or danger-full-access");
  }
  const permissionMode = explicitMode ?? sessionSandboxMode(presets, exec);
  const rawModel = args.model;
  if (rawModel !== undefined && typeof rawModel !== "string") {
    throw new Error("model must be a provider/model string");
  }
  const reasoningEffort = typeof args.reasoning_effort === "string" ? args.reasoning_effort : undefined;
  if (reasoningEffort !== undefined && reasoningEffort.trim().length === 0) {
    throw new Error("reasoning_effort must be a non-empty string");
  }
  const model = rawModel === undefined ? undefined : (parseModelSpec(rawModel, reasoningEffort) ?? undefined);
  if (rawModel !== undefined && model === undefined) {
    throw new Error("model must be a provider/model string");
  }
  const orcaNode = await requireNode(handle);
  const input: SubmitTaskInput = {
    message: { role: "user", parts: [{ kind: "text", text }] },
    metadata: {
      echo,
      pod: {
        permission_mode: permissionMode,
        model,
        reasoning_effort: model === undefined ? reasoningEffort : undefined,
      },
    },
  };
  const view = await orcaNode.sendTask(peer, input);
  // Track the task so the dispatching agent is told when it finishes, even
  // after its turn ends.
  if (exec?.agent !== undefined) tracker.track(exec.agent, peer, view.id);
  return { task_id: view.id, state: view.status.state, peer };
}

async function runStatus(handle: PodHandle, args: Record<string, unknown>): Promise<unknown> {
  const peer = normalizePeerUrl(requiredString(args, "peer"));
  const taskId = requiredString(args, "task_id");
  const orcaNode = await requireNode(handle);
  const view = await orcaNode.getTask(peer, taskId);
  return { ...view, terminal: isTerminal(view.status.state) };
}

async function runCancel(handle: PodHandle, args: Record<string, unknown>): Promise<unknown> {
  const peer = normalizePeerUrl(requiredString(args, "peer"));
  const taskId = requiredString(args, "task_id");
  const orcaNode = await requireNode(handle);
  const view = await orcaNode.cancelTask(peer, taskId);
  return { ...view, terminal: isTerminal(view.status.state) };
}

async function runMembers(handle: PodHandle): Promise<unknown> {
  const orcaNode = await requireNode(handle);
  const self = orcaNode.self();
  return {
    self: peerSummary(self),
    members: orcaNode.members().map(peerSummary),
    members_digest: orcaNode.membersDigest(),
  };
}

async function runConnect(handle: PodHandle, args: Record<string, unknown>): Promise<unknown> {
  const peer = normalizePeerUrl(requiredString(args, "peer"));
  await requireNode(handle);
  await handle.addPeer(peer);
  const orcaNode = await requireNode(handle);
  return {
    peer,
    members: orcaNode.members().map(peerSummary),
    members_digest: orcaNode.membersDigest(),
  };
}

/** Build the single `orca_pod` tool definition bound to one running pod handle. */
export function createPodTools(
  handle: PodHandle,
  tracker: Tracker,
  presets?: PermissionPresetsService,
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
          enum: ["read-only", "workspace-write", "danger-full-access"],
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
    async execute(args, exec: ToolExecution | undefined) {
      const record = asRecord(args);
      const method = methodOf(record);
      try {
        switch (method) {
          case "send":
            return await runSend(handle, tracker, record, exec, presets);
          case "status":
            return await runStatus(handle, record);
          case "cancel":
            return await runCancel(handle, record);
          case "members":
            return await runMembers(handle);
          case "connect":
            return await runConnect(handle, record);
        }
      } catch (error) {
        throw describeError("orca_pod", error);
      }
    },
  };
  return [tool];
}
