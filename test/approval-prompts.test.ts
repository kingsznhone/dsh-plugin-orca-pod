import { describe, expect, it } from "vitest"

import { createPodAdmin } from "../src/plugin/admin.ts"
import type { PodHandle } from "../src/plugin/lifecycle.ts"
import { createApprovalPrompts } from "../src/plugin/prompts.ts"
import { createPodTools } from "../src/plugin/tools.ts"
import type { Tracker } from "../src/plugin/tracker.ts"
import type { ToolExecution } from "../src/plugin/dsh.ts"
import type { OrcaNode } from "../src/orca_node.ts"
import type { PermissionRequest, TaskView } from "../src/protocol.ts"

const PEER = "http://127.0.0.1:11812"
const TASK = "TASK01"

const REQUEST: PermissionRequest = {
  request_id: "req-1",
  task_id: TASK,
  tool: "write_file",
  requested: { path: "report.md" },
  requested_by: "NODE02",
  via: ["NODE01"],
}

function inputRequired(): TaskView {
  return {
    kind: "task",
    id: TASK,
    contextId: "CTX01",
    status: {
      state: "input-required",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "agent", parts: [{ kind: "data", data: { permission_request: REQUEST } }] },
    },
  }
}

function completed(): TaskView {
  return {
    kind: "task",
    id: TASK,
    contextId: "CTX01",
    status: { state: "completed", timestamp: "2026-01-01T00:00:01.000Z" },
  }
}

/** Minimal node whose task resumes as soon as it is approved. */
function fakeNode(): OrcaNode & { approved: number; denied: number } {
  let resumed = false
  const node = {
    approved: 0,
    denied: 0,
    async getTask() {
      return resumed ? completed() : inputRequired()
    },
    async approveTask() {
      node.approved += 1
      resumed = true
      return completed()
    },
    async denyTask() {
      node.denied += 1
      resumed = true
      return completed()
    },
    async listTasks() {
      return []
    },
    self() {
      return { orca_node_id: "NODE01", display_name: "node one", endpoints: [] }
    },
    members() {
      return []
    },
    listDispatches() {
      return []
    },
    blobLink() {
      return null
    },
  }
  return node as unknown as OrcaNode & { approved: number; denied: number }
}

function fakeHandle(node: OrcaNode): PodHandle {
  return {
    runtime: { orcaNode: node, port: 11811, error: null },
    config: { workgroup_id: "wg", workgroup_password: "pw", port: 11811, skill_injection: false, peers: [] },
    uiConfigured: true,
    ready: Promise.resolve(),
    reconfigure: async () => {},
    addPeer: async () => {},
    disconnect: async () => {},
    reset: async () => {},
  } as unknown as PodHandle
}

function fakeTracker(): Tracker {
  return { list: () => [], subscribe: () => () => {}, track: () => {}, stop: () => {}, size: () => 0 } as unknown as Tracker
}

const EXEC = { agent: { id: "session-1" } } as unknown as ToolExecution

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("approval prompts", () => {
  it("parks a request, answers once and clears it", async () => {
    const prompts = createApprovalPrompts()
    const pending = prompts.request({ peer: PEER, task_id: TASK, request: REQUEST, agent_id: "session-1" })
    expect(prompts.list()).toEqual([pending.prompt])
    expect(prompts.resolve(PEER, TASK, "allow")).toBe(true)
    await expect(pending.wait()).resolves.toBe("allow")
    expect(prompts.list()).toEqual([])
    expect(prompts.resolve(PEER, TASK, "deny")).toBe(false)
  })

  it("replaces an earlier prompt for the same task", async () => {
    const prompts = createApprovalPrompts()
    const first = prompts.request({ peer: PEER, task_id: TASK, request: REQUEST, agent_id: "session-1" })
    const second = prompts.request({ peer: PEER, task_id: TASK, request: REQUEST, agent_id: "session-2" })
    await expect(first.wait()).resolves.toBeNull()
    expect(prompts.list()).toEqual([second.prompt])
    expect(prompts.resolve(PEER, TASK, "deny")).toBe(true)
    await expect(second.wait()).resolves.toBe("deny")
  })

  it("cancels every parked prompt when the plugin unloads", async () => {
    const prompts = createApprovalPrompts()
    const pending = prompts.request({ peer: PEER, task_id: TASK, request: REQUEST, agent_id: "session-1" })
    let notified = 0
    const unsubscribe = prompts.subscribe(() => {
      notified += 1
    })
    prompts.cancelAll()
    await expect(pending.wait()).resolves.toBeNull()
    expect(notified).toBeGreaterThan(0)
    unsubscribe()
  })

  it("keeps pod_approve parked until the panel approves it", async () => {
    const prompts = createApprovalPrompts()
    const node = fakeNode()
    const handle = fakeHandle(node)
    const admin = createPodAdmin(handle, fakeTracker(), { prompts })
    const tool = createPodTools(handle, fakeTracker(), { prompts }).find((candidate) => candidate.name === "pod_approve")
    expect(tool).toBeDefined()

    const parked = tool!.execute({ peer: PEER, task_id: TASK, decision: "allow" }, EXEC)
    await waitFor(() => prompts.list().length === 1)
    expect(prompts.list()[0]!.agent_id).toBe("session-1")

    const resumed = await admin.approve(PEER, TASK)
    expect(resumed.status.state).toBe("completed")
    const result = (await parked) as { decision: string; state: string }
    expect(result).toMatchObject({ decision: "approved", state: "completed" })
    expect(node.approved).toBe(1)
    expect(prompts.list()).toEqual([])
  })

  it("denies the task when the panel rejects a parked approval", async () => {
    const prompts = createApprovalPrompts()
    const node = fakeNode()
    const handle = fakeHandle(node)
    const admin = createPodAdmin(handle, fakeTracker(), { prompts })
    const tool = createPodTools(handle, fakeTracker(), { prompts }).find((candidate) => candidate.name === "pod_approve")

    const parked = tool!.execute({ peer: PEER, task_id: TASK, decision: "allow" }, EXEC)
    await waitFor(() => prompts.list().length === 1)
    await admin.deny(PEER, TASK)
    const result = (await parked) as { decision: string }
    expect(result.decision).toBe("denied")
    expect(node.denied).toBe(1)
  })
})
