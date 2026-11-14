/**
 * Background task tracker for the DSH host bundle.
 *
 * `pod_send` returns as soon as the remote orca node accepts a task, so the
 * dispatching agent ends its turn while the task keeps running. The tracker
 * polls those tasks, coalesces their terminal states, and hands one notice back
 * to the dispatching agent through the DSH Agent interface:
 *
 * - agent still running: `agent.inject()` adds context to the next step
 *   without waking it;
 * - agent idle: `agent.followup()` starts a new turn with the notice.
 *
 * The notice is a normal user-role message created by this bundle, because the
 * host-side plugin cannot import `@deepseek-ai/dsh-llm`.
 */

import { randomUUID } from "node:crypto"

import { isTerminal, permissionRequestOf } from "../protocol.ts"
import type { PermissionRequest, TaskView } from "../protocol.ts"
import type { AgentNotice, HostLogger, ToolAgent } from "./dsh.ts"
import { errorMessage } from "./util.ts"

/** The DSH Agent surface used to return a notice to the dispatching session. */
export type TrackerAgent = ToolAgent

/** User-role message shape accepted by the DSH inbox. */
export type TrackerMessage = AgentNotice

/** The one orca-node method the tracker needs. */
export interface TrackerNode {
  getTask(peerUrl: string, taskId: string): Promise<TaskView>
}

/** Construction options; every value has a production default. */
export interface TrackerOptions {
  /** Poll period for pending tasks. */
  intervalMs?: number
  /** Terminal notifications closer together than this are delivered as one notice. */
  coalesceMs?: number
  /** Consecutive wake-ups allowed without the agent running in between. */
  maxConsecutiveWakes?: number
  logger?: HostLogger
}

/** Tracker handle returned to the plugin. */
export interface Tracker {
  /** Start watching a task dispatched by the given agent. */
  track(agent: TrackerAgent, peer: string, taskId: string): void
  /** Stop polling and drop pending notices. */
  stop(): void
  /** Number of tasks still being watched (tests and diagnostics). */
  size(): number
}

interface PendingTask {
  agent: TrackerAgent
  peer: string
  taskId: string
  /** Last permission request already surfaced to the agent. */
  seenRequest: string | null
}

interface FinishedTask extends PendingTask {
  kind: "terminal" | "permission"
  view: TaskView
  request?: PermissionRequest
}

const DEFAULT_INTERVAL_MS = 1000
const DEFAULT_COALESCE_MS = 2000
const DEFAULT_MAX_CONSECUTIVE_WAKES = 3
const SUMMARY_MAX_CHARS = 120

/** One suspended permission request reduced to the line shown to the agent. */
/**
 * Human-readable suffix naming the orca nodes a permission request travelled
 * through. Chain-relayed requests carry `upstream` (the orca node that really
 * needs the permission) and `via` (ancestors); single-hop requests carry
 * neither and render as an empty string.
 */
export function permissionOriginNote(request: PermissionRequest): string {
  const origin = request.upstream?.filter((id) => id !== request.requested_by) ?? []
  const chain = [...(request.via ?? []), ...origin]
  return chain.length === 0 ? "" : ` via ${chain.join(" → ")}`
}

export function permissionNoticeLine(request: PermissionRequest, peer: string): string {
  const details = JSON.stringify(request.requested)
  return `task ${request.task_id} on ${peer} needs permission for "${request.tool}" (${details})${permissionOriginNote(request)}; call pod_approve with peer, task_id and decision to answer`
}

/** One terminal task reduced to the line shown to the agent. */
export function taskNoticeLine(view: TaskView, peer: string): string {
  const state = view.status.state
  const parts = [`task ${view.id} on ${peer} is ${state}`]
  const text = view.status.message?.parts
    ?.map((part) => (part.kind === "text" ? part.text : ""))
    .join(" ")
    .trim()
  if (text) parts.push(`result: ${text}`)
  if (view.artifacts && view.artifacts.length > 0) {
    parts.push(`artifacts: ${view.artifacts.map((artifact) => `${artifact.name} (${artifact.artifactId})`).join(", ")}`)
  }
  if (view.status.reason) parts.push(`reason: ${view.status.reason}`)
  return parts.join("; ")
}

function clampSummary(text: string): string {
  return text.length <= SUMMARY_MAX_CHARS ? text : `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * Create a tracker bound to one running orca node.
 *
 * Polling is lazy: tasks are watched only while at least one is pending, so an
 * idle DSH session performs no work.
 */
export function createTracker(getNode: () => TrackerNode | null, options: TrackerOptions = {}): Tracker {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS
  const maxConsecutiveWakes = options.maxConsecutiveWakes ?? DEFAULT_MAX_CONSECUTIVE_WAKES
  const logger = options.logger

  const pending = new Map<string, PendingTask>()
  const finished: FinishedTask[] = []
  const awake = new Map<string, number>()
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  function ensurePolling(): void {
    if (pollTimer !== undefined || stopped) return
    pollTimer = setInterval(() => {
      void poll()
    }, intervalMs)
    pollTimer.unref?.()
  }

  async function poll(): Promise<void> {
    const node = getNode()
    if (node === null) return
    for (const [key, entry] of [...pending]) {
      try {
        const view = await node.getTask(entry.peer, entry.taskId)
        const request = permissionRequestOf(view)
        if (request !== null) {
          // A suspended permission request is surfaced once; the task stays
          // tracked until it finishes or the request changes.
          if (request.request_id !== entry.seenRequest) {
            entry.seenRequest = request.request_id
            finished.push({ ...entry, kind: "permission", view, request })
            scheduleFlush()
          }
          continue
        }
        if (!isTerminal(view.status.state)) continue
        pending.delete(key)
        finished.push({ ...entry, kind: "terminal", view })
        scheduleFlush()
      } catch (error) {
        // A vanished task (404) or a transient network failure must not wedge the
        // tracker; drop it and let the agent discover the state through pod_status.
        pending.delete(key)
        logger?.warn(`orca-pod: stopped tracking ${entry.taskId} on ${entry.peer}: ${errorMessage(error)}`)
      }
    }
    if (pending.size === 0 && pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  function scheduleFlush(): void {
    if (coalesceTimer !== undefined) return
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined
      flush()
    }, coalesceMs)
    coalesceTimer.unref?.()
  }

  function flush(): void {
    const batches = new Map<string, { agent: TrackerAgent; lines: string[]; force: boolean }>()
    for (const task of finished.splice(0)) {
      const batch = batches.get(task.agent.id) ?? { agent: task.agent, lines: [], force: false }
      if (task.kind === "permission" && task.request !== undefined) {
        batch.lines.push(permissionNoticeLine(task.request, task.peer))
        batch.force = true
      } else {
        batch.lines.push(taskNoticeLine(task.view, task.peer))
      }
      batches.set(task.agent.id, batch)
    }
    for (const { agent, lines, force } of batches.values()) deliver(agent, lines, force)
  }

  function deliver(agent: TrackerAgent, lines: string[], force = false): void {
    const text = lines.map((line) => `[orca-pod] ${line}`).join("\n")
    const summary = lines.length === 1 ? lines[0]! : `${lines.length} background tasks need attention`
    const message: TrackerMessage = {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "orca-pod", form: "notice", summary: clampSummary(summary) },
    }
    try {
      // A permission request blocks the remote task, so it always wakes the
      // dispatching agent regardless of the wake budget (§7.12).
      if (force) {
        agent.followup(message)
        awake.set(agent.id, 0)
        return
      }
      if (agent.status === "running") {
        agent.inject(message)
        awake.set(agent.id, 0)
        return
      }
      const count = awake.get(agent.id) ?? 0
      if (count >= maxConsecutiveWakes) {
        // Budget exhausted: leave the notice unread in the inbox instead of
        // waking the agent again. A later user turn will pick it up.
        agent.inject(message)
        return
      }
      agent.followup(message)
      awake.set(agent.id, count + 1)
    } catch (error) {
      logger?.warn(`orca-pod: failed to notify agent ${agent.id}: ${errorMessage(error)}`)
    }
  }

  return {
    track(agent, peer, taskId) {
      if (stopped) return
      pending.set(`${peer}|${taskId}`, { agent, peer, taskId, seenRequest: null })
      ensurePolling()
    },
    stop() {
      stopped = true
      if (pollTimer !== undefined) clearInterval(pollTimer)
      if (coalesceTimer !== undefined) clearTimeout(coalesceTimer)
      pollTimer = undefined
      coalesceTimer = undefined
      pending.clear()
      finished.length = 0
    },
    size() {
      return pending.size + finished.length
    },
  }
}
