/**
 * In-flight human approval prompts (§7.13 / §9.2).
 *
 * `pod_approve` does not raise the native DSH approval card: it parks the tool
 * call here and lets the Orca Pod UI answer it — the chat card when the asking
 * session is on screen, otherwise the popup or the panel's approval list. The
 * wait has no timeout: a desktop main session blocks until the user answers,
 * and a CLI/ACP session is never asked directly (it has an upstream
 * that owns the decision).
 */

import { randomUUID } from "node:crypto"

import type { PermissionRequest } from "../protocol.ts"

/** One approval the UI may answer; `agent_id` is the session that asked. */
export interface ApprovalPrompt {
  id: string
  peer: string
  task_id: string
  request_id: string
  tool: string
  requested: unknown
  agent_id: string
  created_at: string
}

export type PromptDecision = "allow" | "deny"

/** A prompt being awaited by a `pod_approve` call. */
export interface PendingPrompt {
  prompt: ApprovalPrompt
  /** Resolves with the user's decision, or null when the prompt is withdrawn. */
  wait(): Promise<PromptDecision | null>
  /** Withdraw without a decision (node stop, task gone). */
  cancel(): void
}

export interface ApprovalPrompts {
  request(input: {
    peer: string
    task_id: string
    request: PermissionRequest
    agent_id: string
  }): PendingPrompt
  /**
   * Park a prompt raised by the tracker rather than by a `pod_approve` call.
   * `onDecision` runs the remote decision (approve/deny the parked task) once
   * the user answers in the UI, so no agent-visible notice is needed.
   */
  park(input: {
    peer: string
    task_id: string
    request: PermissionRequest
    agent_id: string
    onDecision: (decision: PromptDecision) => Promise<unknown> | unknown
  }): ApprovalPrompt
  /** Pending prompts, newest last. */
  list(): ApprovalPrompt[]
  /** Answer the prompt for one task; false when no prompt is pending there. */
  resolve(peer: string, taskId: string, decision: PromptDecision): boolean
  /** Drop a prompt without a decision (task finished or was cancelled remotely). */
  withdraw(peer: string, taskId: string): boolean
  /** Withdraw every pending prompt (node stop). */
  cancelAll(): void
  subscribe(listener: () => void): () => void
}

function keyOf(peer: string, taskId: string): string {
  return `${peer}|${taskId}`
}

export function createApprovalPrompts(now: () => number = Date.now): ApprovalPrompts {
  const waiters = new Map<
    string,
    {
      prompt: ApprovalPrompt
      settle: (decision: PromptDecision | null) => void
      onDecision?: (decision: PromptDecision) => Promise<unknown> | unknown
    }
  >()
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A subscriber must not break the node.
      }
    }
  }

  function makePrompt(input: {
    peer: string
    task_id: string
    request: PermissionRequest
    agent_id: string
  }): ApprovalPrompt {
    return {
      id: randomUUID(),
      peer: input.peer,
      task_id: input.task_id,
      request_id: input.request.request_id,
      tool: input.request.tool,
      requested: input.request.requested,
      agent_id: input.agent_id,
      created_at: new Date(now()).toISOString(),
    }
  }

  return {
    request(input) {
      const prompt = makePrompt(input)
      let settle!: (decision: PromptDecision | null) => void
      const settled = new Promise<PromptDecision | null>((resolve) => {
        settle = resolve
      })
      const key = keyOf(prompt.peer, prompt.task_id)
      waiters.get(key)?.settle(null)
      waiters.set(key, { prompt, settle })
      notify()
      return {
        prompt,
        wait: () => settled,
        cancel: () => {
          if (waiters.get(key)?.prompt.id === prompt.id) {
            waiters.delete(key)
            settle(null)
            notify()
          }
        },
      }
    },
    park(input) {
      const prompt = makePrompt(input)
      const key = keyOf(prompt.peer, prompt.task_id)
      waiters.get(key)?.settle(null)
      waiters.set(key, { prompt, settle: () => {}, onDecision: input.onDecision })
      notify()
      return prompt
    },
    list() {
      return [...waiters.values()].map((entry) => entry.prompt)
    },
    resolve(peer, taskId, decision) {
      const key = keyOf(peer, taskId)
      const entry = waiters.get(key)
      if (entry === undefined) return false
      waiters.delete(key)
      entry.settle(decision)
      notify()
      if (entry.onDecision !== undefined) {
        // The tracker-parked prompt owns the remote decision; the UI already
        // answered, so run it without blocking the HTTP response.
        void Promise.resolve()
          .then(() => entry.onDecision?.(decision))
          .catch(() => {
            // A failed approve/deny leaves the remote task parked; its notice
            // path and pod_status still surface the state.
          })
      }
      return true
    },
    withdraw(peer, taskId) {
      const key = keyOf(peer, taskId)
      const entry = waiters.get(key)
      if (entry === undefined) return false
      waiters.delete(key)
      entry.settle(null)
      notify()
      return true
    },
    cancelAll() {
      if (waiters.size === 0) return
      const entries = [...waiters.values()]
      waiters.clear()
      for (const entry of entries) entry.settle(null)
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
