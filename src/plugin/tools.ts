/**
 * DSH tools registered by the Orca pod bundle.
 *
 * All four tools are non-blocking wrappers over `OrcaNode`: tasks are executed
 * asynchronously by the remote pod, so `pod_send` returns a task id immediately
 * and callers poll `pod_status` for the result.
 */

import { isHttpEndpoint, isTerminal, permissionRequestOf } from "../protocol.ts"
import type { PermissionRequest } from "../protocol.ts"
import type { A2AMessage, PeerView, SubmitTaskInput } from "../protocol.ts"
import type { OrcaNode } from "../orca_node.ts"

import type { ApprovalService, ContentBlock, RawJsonSchema, ToolDefinition, ToolExecution } from "./dsh.ts"
import type { PodHandle } from "./lifecycle.ts"
import { permissionOriginNote, type Tracker } from "./tracker.ts"
import { describeError } from "./util.ts"

const ASYNC_NOTE =
  "The task is executed asynchronously on the remote orca node, so this call returns as soon as the remote accepts it; poll pod_status with the returned task_id to observe completion."

/**
 * Human-facing text of the approval card `pod_approve` raises. Chain-relayed
 * requests name the orca nodes they travelled through; single-hop requests
 * read as a plain "wants to run X".
 */
export function approvalReason(taskId: string, peer: string, request: PermissionRequest): string {
  return `Remote task ${taskId} on ${peer} wants to run "${request.tool}"${permissionOriginNote(request)}: ${JSON.stringify(request.requested)}`
}

/**
 * Output values differ per tool (send/status/cancel return task views, members
 * returns a roster), so the canonical output schema is the unconstrained JSON
 * form. The executor accepts an annotation-only schema for exactly this case.
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

/** Accept `http://host:port` as well as a bare `host:port` endpoint. */
function normalizePeer(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("peer must be a non-empty string holding the peer endpoint URL")
  }
  const raw = value.trim()
  const candidate = /^https?:\/\//i.test(raw) ? raw : /^[^\s/]+:\d+$/.test(raw) ? `http://${raw}` : raw
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
    endpoint: peer.endpoint,
    state: peer.state,
  }
}

/** Host services the approval tool needs; omitted in tests without one. */
export interface PodToolOptions {
  approval?: ApprovalService
}

/** Build the `pod_*` tool definitions bound to one running pod handle. */
export function createPodTools(handle: PodHandle, tracker: Tracker, options: PodToolOptions = {}): ToolDefinition[] {
  const send: ToolDefinition = {
    name: "pod_send",
    description:
      "Send a text task to another Orca node in this workgroup via that peer's A2A endpoint. " +
      ASYNC_NOTE +
      " Use the optional echo script only for deterministic Phase-0 tests.",
    parameters: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "Peer endpoint URL, e.g. http://127.0.0.1:11811 (bare host:port is accepted).",
        },
        text: { type: "string", description: "Task text sent as an A2A user message part." },
        echo: {
          type: "object",
          description:
            "Optional deterministic echo script forwarded as metadata.echo for tests: " +
            "{steps:[{at_ms,suspend:{kind,reason|tool,...}}],final:{state,text},artifacts:[{name,content}]}.",
          additionalProperties: true,
        },
        permission_mode: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description:
            "Origin session permission mode; the target caps it by its own policy and never runs above it (§7.10).",
        },
      },
      required: ["peer", "text"],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec: ToolExecution | undefined) {
      const record = asRecord(args)
      const peer = normalizePeer(record["peer"])
      const text = requiredString(record, "text")
      const echo = optionalEchoScript(record)
      const permissionMode = typeof record["permission_mode"] === "string" ? record["permission_mode"] : undefined
      const orcaNode = await requireNode(handle)
      const message: A2AMessage = { role: "user", parts: [{ kind: "text", text }] }
      const metadata: Record<string, unknown> = {
        ...(echo === undefined ? {} : { echo }),
        ...(permissionMode === undefined ? {} : { pod: { permission_mode: permissionMode } }),
      }
      const input: SubmitTaskInput =
        Object.keys(metadata).length === 0 ? { message } : { message, metadata }
      try {
        const view = await orcaNode.sendTask(peer, input)
        // Track the task so the dispatching agent is told when it finishes, even
        // after its turn ends.
        if (exec?.agent !== undefined) tracker.track(exec.agent, peer, view.id)
        return { task_id: view.id, state: view.status.state, peer }
      } catch (error) {
        throw describeError("pod_send", error)
      }
    },
  }

  const status: ToolDefinition = {
    name: "pod_status",
    description:
      "Fetch the current state of a remote Orca task and its artifacts. " +
      "Tasks on the remote orca node are asynchronous; terminal states are completed, failed and canceled.",
    parameters: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "Peer endpoint URL, e.g. http://127.0.0.1:11811 (bare host:port is accepted).",
        },
        task_id: { type: "string", description: "Task id returned by pod_send." },
      },
      required: ["peer", "task_id"],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const record = asRecord(args)
      const peer = normalizePeer(record["peer"])
      const taskId = requiredString(record, "task_id")
      const orcaNode = await requireNode(handle)
      try {
        const view = await orcaNode.getTask(peer, taskId)
        return { ...view, terminal: isTerminal(view.status.state) }
      } catch (error) {
        throw describeError("pod_status", error)
      }
    },
  }

  const cancel: ToolDefinition = {
    name: "pod_cancel",
    description:
      "Request cancellation of a remote Orca task. " +
      "The remote orca node finishes the cancellation asynchronously; the returned task view is the state observed at cancel time, so poll pod_status when it is not yet terminal.",
    parameters: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "Peer endpoint URL, e.g. http://127.0.0.1:11811 (bare host:port is accepted).",
        },
        task_id: { type: "string", description: "Task id returned by pod_send." },
      },
      required: ["peer", "task_id"],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const record = asRecord(args)
      const peer = normalizePeer(record["peer"])
      const taskId = requiredString(record, "task_id")
      const orcaNode = await requireNode(handle)
      try {
        const view = await orcaNode.cancelTask(peer, taskId)
        return { ...view, terminal: isTerminal(view.status.state) }
      } catch (error) {
        throw describeError("pod_cancel", error)
      }
    },
  }

  const approve: ToolDefinition = {
    name: "pod_approve",
    description:
      "Answer a remote Orca task's permission request. " +
      "Call this after a notice says a task needs permission. decision \"allow\" asks the human through the DSH approval card and sends the signed grant; decision \"deny\" fails the remote task with permission_denied. " +
      "Only the task's origin can answer; other members can still read the task.",
    parameters: {
      type: "object",
      properties: {
        peer: {
          type: "string",
          description: "Peer endpoint URL, e.g. http://127.0.0.1:11811 (bare host:port is accepted).",
        },
        task_id: { type: "string", description: "Task id whose permission request is pending." },
        decision: {
          type: "string",
          enum: ["allow", "deny"],
          description: "allow asks the human and grants once; deny fails the remote task.",
        },
        reason: { type: "string", description: "Optional reason recorded on the remote task when denied." },
      },
      required: ["peer", "task_id", "decision"],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec: ToolExecution | undefined) {
      const record = asRecord(args)
      const peer = normalizePeer(record["peer"])
      const taskId = requiredString(record, "task_id")
      const decision = requiredString(record, "decision")
      if (decision !== "allow" && decision !== "deny") {
        throw new Error('decision must be "allow" or "deny"')
      }
      const reason = typeof record["reason"] === "string" ? record["reason"] : undefined
      const orcaNode = await requireNode(handle)
      try {
        const view = await orcaNode.getTask(peer, taskId)
        const request = permissionRequestOf(view)
        if (request === null) {
          throw new Error(`task ${taskId} on ${peer} is not waiting for a permission decision`)
        }
        if (decision === "deny") {
          const task = await orcaNode.denyTask(peer, view, reason ?? "denied by origin")
          return { decision: "denied", task_id: task.id, state: task.status.state, reason: task.status.reason }
        }
        const approval = options.approval
        if (approval === undefined || exec?.agent === undefined) {
          throw new Error("human approval is unavailable in this session; use decision deny instead")
        }
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: "pod_approve",
          reason: approvalReason(taskId, peer, request),
        })
        if (outcome !== "allowed-once") {
          const task = await orcaNode.denyTask(peer, view, `approval ${outcome}`)
          return { decision: "denied", approval: outcome, task_id: task.id, state: task.status.state }
        }
        const task = await orcaNode.approveTask(peer, view)
        return { decision: "approved", approval: outcome, task_id: task.id, state: task.status.state }
      } catch (error) {
        throw describeError("pod_approve", error)
      }
    },
  }

  const members: ToolDefinition = {
    name: "pod_members",
    description:
      "List the local Orca node and the peers it has discovered in this workgroup, with orca node ids, endpoints and states. Use the endpoint values with pod_send, pod_status and pod_cancel.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute() {
      const orcaNode = await requireNode(handle)
      const self = orcaNode.self()
      return {
        self: peerSummary(self),
        members: orcaNode.members().map(peerSummary),
        members_digest: orcaNode.membersDigest(),
      }
    },
  }

  return [send, status, cancel, approve, members]
}
