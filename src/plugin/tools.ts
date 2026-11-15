/**
 * The single DSH tool registered by the Orca pod bundle.
 *
 * Every operation is a method on `orca_pod` instead of a separate tool, so the
 * agent's context carries one schema rather than six. Task methods are
 * non-blocking wrappers over `OrcaNode`: `send` returns a task id immediately
 * and callers poll `status` for the result.
 */

import { isHttpEndpoint, isTerminal, parseModelSpec, permissionRequestOf } from "../protocol.ts"
import type { PermissionRequest } from "../protocol.ts"
import type { A2AMessage, PeerView, SubmitTaskInput } from "../protocol.ts"
import type { OrcaNode } from "../orca_node.ts"

import type { ApprovalService, ContentBlock, RawJsonSchema, ToolDefinition, ToolExecution } from "./dsh.ts"
import type { PodHandle } from "./lifecycle.ts"
import { permissionOriginNote, type Tracker } from "./tracker.ts"
import type { ApprovalPrompts } from "./prompts.ts"
import { describeError } from "./util.ts"

const METHOD_NAMES = ["send", "status", "cancel", "approve", "members", "connect"] as const
type PodMethod = (typeof METHOD_NAMES)[number]

const ASYNC_NOTE =
  "Tasks run asynchronously on the remote orca node: method \"send\" returns as soon as the remote accepts the task, and method \"status\" observes the returned task_id."

const METHODS_HELP =
  "Methods: " +
  'send (peer, text; optional echo, permission_mode, model, reasoning_effort) dispatches a task; ' +
  'status (peer, task_id) reads one task; ' +
  'cancel (peer, task_id) requests cancellation; ' +
  'approve (peer, task_id, decision "allow"|"deny"; optional reason) answers a pending permission request; ' +
  "members (no arguments) lists this node and its peers; " +
  "connect (peer; bare host or host:port defaults to 11811) joins a peer into the mesh."

/**
 * Human-facing text of the approval card the approve method raises. Chain-relayed
 * requests name the orca nodes they travelled through; single-hop requests read
 * as a plain "wants to run X".
 */
export function approvalReason(taskId: string, peer: string, request: PermissionRequest): string {
  return `Remote task ${taskId} on ${peer} wants to run "${request.tool}"${permissionOriginNote(request)}: ${JSON.stringify(request.requested)}`
}

/**
 * Output values differ per method (send/status/cancel return task views,
 * members returns a roster), so the canonical output schema is the unconstrained
 * JSON form. The executor accepts an annotation-only schema for exactly this case.
 */
const OUTPUT_SCHEMA: RawJsonSchema = { description: "JSON payload rendered as text." }

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }]
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("tool arguments must be an object")
  }
  return args as Record<string, unknown>
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`)
  }
  return value.trim()
}

function methodOf(args: Record<string, unknown>): PodMethod {
  const value = requiredString(args, "method")
  if (!(METHOD_NAMES as readonly string[]).includes(value)) {
    throw new Error(`method must be one of ${METHOD_NAMES.map((name) => `"${name}"`).join(", ")}`)
  }
  return value as PodMethod
}

/** Accept `http://host:port` as well as a bare `host` or `host:port` endpoint. */
function normalizePeer(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("peer must be a non-empty string holding the peer endpoint URL")
  }
  const raw = value.trim()
  const candidate = /^https?:\/\//i.test(raw)
    ? raw
    : /:[0-9]+$/.test(raw)
      ? `http://${raw}`
      : `http://${raw}:11811`
  if (!isHttpEndpoint(candidate)) {
    throw new Error("peer must be an http(s) URL such as http://127.0.0.1:11811")
  }
  return candidate.replace(/\/+$/, "")
}

function optionalEchoScript(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = args["echo"]
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("echo must be an object holding a deterministic echo script")
  }
  return value as Record<string, unknown>
}

/** Wait for startup, then fail the tool call when the orca node is not usable. */
async function requireNode(handle: PodHandle): Promise<OrcaNode> {
  await handle.ready
  if (handle.runtime.error !== null) {
    throw new Error(`orca node is not running: ${handle.runtime.error.message}`)
  }
  const orcaNode = handle.runtime.orcaNode
  if (orcaNode === null) {
    throw new Error("orca node is not running")
  }
  return orcaNode
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
  }
}

/** Host services the approve method needs; omitted in tests without one. */
export interface PodToolOptions {
  approval?: ApprovalService
  /**
   * UI answer channel for the approve method (§9.2). When present the tool parks
   * until the chat card, popup or panel answers it, with no timeout; the native
   * DSH approval card is only used when no UI channel is attached.
   */
  prompts?: ApprovalPrompts
}

async function runSend(
  handle: PodHandle,
  tracker: Tracker,
  args: Record<string, unknown>,
  exec: ToolExecution | undefined,
): Promise<unknown> {
  const peer = normalizePeer(args["peer"])
  const text = requiredString(args, "text")
  const echo = optionalEchoScript(args)
  const permissionMode = typeof args["permission_mode"] === "string" ? args["permission_mode"] : undefined
  const rawModel = args["model"]
  if (rawModel !== undefined && typeof rawModel !== "string") {
    throw new Error("model must be a provider/model string")
  }
  const reasoningEffort = typeof args["reasoning_effort"] === "string" ? args["reasoning_effort"] : undefined
  if (reasoningEffort !== undefined && reasoningEffort.trim().length === 0) {
    throw new Error("reasoning_effort must be a non-empty string")
  }
  const model = rawModel === undefined ? null : parseModelSpec(rawModel, reasoningEffort)
  if (rawModel !== undefined && model === null) {
    throw new Error("model must be a provider/model string")
  }
  const orcaNode = await requireNode(handle)
  const message: A2AMessage = { role: "user", parts: [{ kind: "text", text }] }
  const pod: Record<string, unknown> = {
    ...(permissionMode === undefined ? {} : { permission_mode: permissionMode }),
    ...(model === null ? {} : { model }),
    ...(model === null && reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
  }
  const metadata: Record<string, unknown> = {
    ...(echo === undefined ? {} : { echo }),
    ...(Object.keys(pod).length === 0 ? {} : { pod }),
  }
  const input: SubmitTaskInput = Object.keys(metadata).length === 0 ? { message } : { message, metadata }
  const view = await orcaNode.sendTask(peer, input)
  // Track the task so the dispatching agent is told when it finishes, even
  // after its turn ends.
  if (exec?.agent !== undefined) tracker.track(exec.agent, peer, view.id)
  return { task_id: view.id, state: view.status.state, peer }
}

async function runStatus(handle: PodHandle, args: Record<string, unknown>): Promise<unknown> {
  const peer = normalizePeer(args["peer"])
  const taskId = requiredString(args, "task_id")
  const orcaNode = await requireNode(handle)
  const view = await orcaNode.getTask(peer, taskId)
  return { ...view, terminal: isTerminal(view.status.state) }
}

async function runCancel(handle: PodHandle, args: Record<string, unknown>): Promise<unknown> {
  const peer = normalizePeer(args["peer"])
  const taskId = requiredString(args, "task_id")
  const orcaNode = await requireNode(handle)
  const view = await orcaNode.cancelTask(peer, taskId)
  return { ...view, terminal: isTerminal(view.status.state) }
}

async function runMembers(handle: PodHandle): Promise<unknown> {
  const orcaNode = await requireNode(handle)
  const self = orcaNode.self()
  return {
    self: peerSummary(self),
    members: orcaNode.members().map(peerSummary),
    members_digest: orcaNode.membersDigest(),
  }
}

async function runConnect(handle: PodHandle, args: Record<string, unknown>): Promise<unknown> {
  const peer = normalizePeer(args["peer"])
  await requireNode(handle)
  await handle.addPeer(peer)
  const orcaNode = await requireNode(handle)
  return {
    peer,
    members: orcaNode.members().map(peerSummary),
    members_digest: orcaNode.membersDigest(),
  }
}

async function runApprove(
  handle: PodHandle,
  options: PodToolOptions,
  args: Record<string, unknown>,
  exec: ToolExecution | undefined,
): Promise<unknown> {
  const peer = normalizePeer(args["peer"])
  const taskId = requiredString(args, "task_id")
  const decision = requiredString(args, "decision")
  if (decision !== "allow" && decision !== "deny") {
    throw new Error('decision must be "allow" or "deny"')
  }
  const reason = typeof args["reason"] === "string" ? args["reason"] : undefined
  const orcaNode = await requireNode(handle)
  const view = await orcaNode.getTask(peer, taskId)
  const request = permissionRequestOf(view)
  if (request === null) {
    throw new Error(`task ${taskId} on ${peer} is not waiting for a permission decision`)
  }
  if (decision === "deny") {
    const task = await orcaNode.denyTask(peer, view, reason ?? "denied by origin")
    return { decision: "denied", task_id: task.id, state: task.status.state, reason: task.status.reason }
  }
  if (options.prompts !== undefined && exec?.agent !== undefined) {
    // Park the call until the Orca Pod UI answers; there is deliberately no
    // timeout, so the window can stay open for as long as it takes.
    const pending = options.prompts.request({
      peer,
      task_id: taskId,
      request,
      agent_id: exec.agent.id,
    })
    const answer = await pending.wait()
    if (answer !== "allow") {
      const task = await orcaNode.denyTask(
        peer,
        view,
        answer === "deny" ? "denied in the Orca Pod UI" : "approval cancelled",
      )
      return { decision: "denied", approval: answer ?? "cancelled", task_id: task.id, state: task.status.state }
    }
    const task = await orcaNode.approveTask(peer, view)
    return { decision: "approved", approval: "allowed-once", task_id: task.id, state: task.status.state }
  }
  const approval = options.approval
  if (approval === undefined || exec?.agent === undefined) {
    throw new Error("human approval is unavailable in this session; use decision deny instead")
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: "orca_pod",
    reason: approvalReason(taskId, peer, request),
  })
  if (outcome !== "allowed-once") {
    const task = await orcaNode.denyTask(peer, view, `approval ${outcome}`)
    return { decision: "denied", approval: outcome, task_id: task.id, state: task.status.state }
  }
  const task = await orcaNode.approveTask(peer, view)
  return { decision: "approved", approval: outcome, task_id: task.id, state: task.status.state }
}

/** Build the single `orca_pod` tool definition bound to one running pod handle. */
export function createPodTools(handle: PodHandle, tracker: Tracker, options: PodToolOptions = {}): ToolDefinition[] {
  const tool: ToolDefinition = {
    name: "orca_pod",
    description:
      "Operate the Orca Pod mesh from this session: dispatch and inspect tasks on other orca nodes, answer permission requests, list members, or join a new peer. " +
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
          description:
            "Target peer: http://host:port, host:port, or a bare host (port defaults to 11811). Required by send, status, cancel, approve and connect.",
        },
        text: { type: "string", description: "send: task text sent as an A2A user message part." },
        task_id: { type: "string", description: "status/cancel/approve: task id returned by method \"send\"." },
        decision: {
          type: "string",
          enum: ["allow", "deny"],
          description: "approve: allow asks the human and grants once; deny fails the remote task.",
        },
        reason: { type: "string", description: "approve: optional reason recorded on the remote task when denied." },
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
            "send: origin session permission mode; the target caps it by its own policy and never runs above it (§7.10).",
        },
        model: {
          type: "string",
          description:
            "send: optional model for the target task as provider/model (§6.15). The target must advertise it and run the ACP executor.",
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
      const record = asRecord(args)
      const method = methodOf(record)
      try {
        switch (method) {
          case "send":
            return await runSend(handle, tracker, record, exec)
          case "status":
            return await runStatus(handle, record)
          case "cancel":
            return await runCancel(handle, record)
          case "approve":
            return await runApprove(handle, options, record, exec)
          case "members":
            return await runMembers(handle)
          case "connect":
            return await runConnect(handle, record)
        }
      } catch (error) {
        throw describeError("orca_pod", error)
      }
    },
  }
  return [tool]
}
