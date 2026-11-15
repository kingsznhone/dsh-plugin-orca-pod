import { describe, expect, it } from "vitest"

import { permissionRequestOf } from "../src/protocol.ts"
import type { TaskState, TaskView } from "../src/protocol.ts"
import type { AgentNotice, ToolAgent } from "../src/plugin/dsh.ts"
import { createTracker, permissionOriginNote, taskNoticeLine } from "../src/plugin/tracker.ts"
import { approvalReason } from "../src/plugin/tools.ts"

class FakeAgent implements ToolAgent {
  readonly id = "agent-1"
  status: "idle" | "running" = "idle"
  readonly injected: AgentNotice[] = []
  readonly followed: AgentNotice[] = []

  inject(message: AgentNotice): void {
    this.injected.push(message)
  }

  followup(message: AgentNotice): void {
    this.followed.push(message)
  }
}

function taskView(id: string, state: TaskState, text?: string): TaskView {
  return {
    kind: "task",
    id,
    contextId: "ctx-1",
    status: {
      state,
      timestamp: new Date().toISOString(),
      ...(text === undefined ? {} : { message: { role: "agent", parts: [{ kind: "text", text }] } }),
    },
  }
}

function permissionView(id: string, requestId: string): TaskView {
  return {
    kind: "task",
    id,
    contextId: "ctx-1",
    status: {
      state: "input-required",
      timestamp: new Date().toISOString(),
      message: {
        role: "agent",
        parts: [
          {
            kind: "data",
            data: {
              permission_request: {
                request_id: requestId,
                task_id: id,
                tool: "write_file",
                requested: { path: "note.txt" },
                requested_by: "TARGET1",
                via: ["ORIGIN"],
                expires_at: new Date(Date.now() + 60_000).toISOString(),
              },
            },
          },
        ],
      },
    },
  };
}

function fakeNode(views: Map<string, TaskView>) {
  return {
    async getTask(_peer: string, taskId: string): Promise<TaskView> {
      const view = views.get(taskId)
      if (view === undefined) throw new Error(`unknown task ${taskId}`)
      return view
    },
  }
}

function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (check()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"))
      setTimeout(tick, 5)
    }
    tick()
  })
}

const fast = { intervalMs: 5, coalesceMs: 10 }

describe("task notice", () => {
  it("summarizes state, result text and artifacts", () => {
    const line = taskNoticeLine(
      {
        ...taskView("01TASK", "completed", "all green"),
        artifacts: [{ artifactId: "abc123", name: "report.txt", bytes: 10 }],
      },
      "http://127.0.0.1:11811",
    )
    expect(line).toContain("01TASK")
    expect(line).toContain("completed")
    expect(line).toContain("result: all green")
    expect(line).toContain("report.txt (abc123)")
  })

  it("surfaces a completed task that reports a blocker", () => {
    const line = taskNoticeLine(
      taskView("01BLOCK", "completed", "BLOCKED: node-c unreachable; rerun after it recovers"),
      "http://127.0.0.1:11811",
    )
    expect(line).toContain("completed with a blocker report")
    expect(line).toContain("BLOCKED: node-c unreachable")
  })
})

describe("createTracker", () => {
  it("wakes an idle agent once when a tracked task finishes", async () => {
    const agent = new FakeAgent()
    const views = new Map([["01TASK", taskView("01TASK", "completed", "done")]])
    const tracker = createTracker(() => fakeNode(views), fast)
    tracker.track(agent, "http://peer:11811", "01TASK")
    expect(tracker.size()).toBe(1)
    await waitFor(() => agent.followed.length === 1)
    expect(agent.injected).toHaveLength(0)
    expect(agent.followed[0]!.content[0].text).toContain("01TASK")
    expect(agent.followed[0]!.source.kind).toBe("tool-jobs")
    expect(tracker.size()).toBe(0)
    tracker.stop()
  })

  it("injects without waking while the agent is running", async () => {
    const agent = new FakeAgent()
    agent.status = "running"
    const views = new Map([["01TASK", taskView("01TASK", "failed")]])
    const tracker = createTracker(() => fakeNode(views), fast)
    tracker.track(agent, "http://peer:11811", "01TASK")
    await waitFor(() => agent.injected.length === 1)
    expect(agent.followed).toHaveLength(0)
    tracker.stop()
  })

  it("coalesces tasks finishing together into one notice", async () => {
    const agent = new FakeAgent()
    const views = new Map([
      ["01A", taskView("01A", "completed")],
      ["01B", taskView("01B", "failed")],
    ])
    const tracker = createTracker(() => fakeNode(views), fast)
    tracker.track(agent, "http://peer:11811", "01A")
    tracker.track(agent, "http://peer:11811", "01B")
    await waitFor(() => agent.followed.length === 1)
    expect(agent.followed).toHaveLength(1)
    expect(agent.followed[0]!.content[0].text.split("\n")).toHaveLength(2)
    tracker.stop()
  })

  it("stops waking after the consecutive wake budget and leaves the notice in the inbox", async () => {
    const agent = new FakeAgent()
    const views = new Map<string, TaskView>()
    const tracker = createTracker(() => fakeNode(views), { ...fast, maxConsecutiveWakes: 1 })

    views.set("01A", taskView("01A", "completed"))
    tracker.track(agent, "http://peer:11811", "01A")
    await waitFor(() => agent.followed.length === 1)

    views.set("01B", taskView("01B", "completed"))
    tracker.track(agent, "http://peer:11811", "01B")
    await waitFor(() => agent.injected.length === 1)
    expect(agent.followed).toHaveLength(1)
    tracker.stop()
  })

  it("forces a wake for a permission request even while the agent is running", async () => {
    const agent = new FakeAgent()
    agent.status = "running"
    const views = new Map([["01TASK", permissionView("01TASK", "req-1")]])
    const tracker = createTracker(() => fakeNode(views), fast)
    tracker.track(agent, "http://peer:11811", "01TASK")

    await waitFor(() => agent.followed.length === 1)
    const notice = agent.followed[0]!.content[0].text
    expect(notice).toContain("needs permission")
    expect(notice).toContain("write_file")
    expect(notice).toContain("orca_pod")
    // The task stays tracked until it settles.
    expect(tracker.size()).toBe(1)

    agent.status = "idle"
    views.set("01TASK", taskView("01TASK", "completed", "written"))
    await waitFor(() => agent.followed.length === 2)
    expect(tracker.size()).toBe(0)
    tracker.stop()
  })

  it("does not repeat the same permission request", async () => {
    const agent = new FakeAgent()
    const views = new Map([["01TASK", permissionView("01TASK", "req-1")]])
    const tracker = createTracker(() => fakeNode(views), fast)
    tracker.track(agent, "http://peer:11811", "01TASK")

    await waitFor(() => agent.followed.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(agent.followed).toHaveLength(1)

    views.set("01TASK", permissionView("01TASK", "req-2"))
    await waitFor(() => agent.followed.length === 2)
    tracker.stop()
  })

  it("leaves a parked permission request to the UI card", async () => {
    const agent = new FakeAgent()
    agent.status = "running"
    const views = new Map([["01TASK", permissionView("01TASK", "req-1")]])
    const tracker = createTracker(() => fakeNode(views), { ...fast, isPromptParked: () => true })
    tracker.track(agent, "http://peer:11811", "01TASK")

    await new Promise((resolve) => setTimeout(resolve, 60))
    // The orca_pod approve call is already parked, so the promise waits on the UI
    // card; injecting a chat notice would only queue a redundant message.
    expect(agent.followed).toHaveLength(0)
    expect(tracker.size()).toBe(1)
    tracker.stop()
  })

  it("drops a queued permission notice when the task settles before delivery", async () => {
    const agent = new FakeAgent()
    agent.status = "running"
    const views = new Map([["01TASK", permissionView("01TASK", "req-1")]])
    const tracker = createTracker(() => fakeNode(views), { intervalMs: 5, coalesceMs: 200 })
    tracker.track(agent, "http://peer:11811", "01TASK")

    // The first poll queues a permission notice; the human answers before the
    // coalesce window closes, so the queued notice is stale chat noise.
    await new Promise((resolve) => setTimeout(resolve, 40))
    views.set("01TASK", taskView("01TASK", "completed", "written"))
    await waitFor(() => agent.injected.length === 1, 2000)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(agent.followed).toHaveLength(0)
    expect(agent.injected[0]!.content[0].text).toContain("completed")
    tracker.stop()
  })

  it("parks once per request id and leaves a tool-parked prompt alone", async () => {
    const agent = new FakeAgent()
    const views = new Map([["01TASK", permissionView("01TASK", "req-1")]])
    const parked: string[] = []
    let toolParked = false
    const tracker = createTracker(() => fakeNode(views), {
      ...fast,
      isPromptParked: () => toolParked,
      onPermission: ({ request }) => {
        parked.push(request.request_id)
        return true
      },
    })
    tracker.track(agent, "http://peer:11811", "01TASK")

    await waitFor(() => parked.length === 1)
    // Several polls follow while the task stays suspended; the same request must
    // not be re-parked (that would remount the UI card every second).
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(parked).toHaveLength(1)

    // Once an `orca_pod` approve call owns the prompt, the tracker must not park
    // a new request: that would settle the approve waiter and deny the task.
    toolParked = true
    views.set("01TASK", permissionView("01TASK", "req-2"))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(parked).toHaveLength(1)
    tracker.stop()
  })

  it("parks a permission request with onPermission instead of injecting a notice", async () => {
    const agent = new FakeAgent()
    agent.status = "running"
    const views = new Map([["01TASK", permissionView("01TASK", "req-1")]])
    const parked: Array<{ peer: string; taskId: string; agentId: string }> = []
    const tracker = createTracker(() => fakeNode(views), {
      ...fast,
      onPermission: ({ peer, taskId, agentId }) => {
        parked.push({ peer, taskId, agentId })
        return true
      },
    })
    tracker.track(agent, "http://peer:11811", "01TASK")

    await waitFor(() => parked.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    // The UI card carries the request; the raw text never enters the chat.
    expect(agent.followed).toHaveLength(0)
    expect(agent.injected).toHaveLength(0)
    expect(parked[0]).toEqual({ peer: "http://peer:11811", taskId: "01TASK", agentId: "agent-1" })
    tracker.stop()
  })

  it("names the orca nodes a permission request travelled through", () => {
    const request = permissionRequestOf(permissionView("01TASK", "req-1"))
    if (request === null) throw new Error("permission request missing")
    expect(permissionOriginNote(request)).toBe(" via ORIGIN")
    expect(permissionOriginNote({ ...request, via: [], upstream: ["LEAF"] })).toBe(" via LEAF")
    expect(permissionOriginNote({ ...request, via: [] })).toBe("")
  })

  it("shows the escalation chain in the approval card reason", () => {
    const reason = approvalReason("01TASK", "http://peer:11811", {
      request_id: "req-1",
      task_id: "01TASK",
      tool: "write_file",
      requested: { path: "note.txt" },
      requested_by: "TARGET1",
      via: ["ORIGIN"],
      upstream: ["LEAF"],
      expires_at: "2026-01-01T00:00:00.000Z",
    })
    expect(reason).toContain('wants to run "write_file"')
    expect(reason).toContain("via ORIGIN → LEAF")
    expect(reason).toContain('"path":"note.txt"')
  })
  it("drops pending work on stop()", async () => {
    const agent = new FakeAgent()
    const views = new Map([["01TASK", taskView("01TASK", "completed")]])
    const tracker = createTracker(() => fakeNode(views), fast)
    tracker.track(agent, "http://peer:11811", "01TASK")
    tracker.stop()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(agent.followed).toHaveLength(0)
    expect(agent.injected).toHaveLength(0)
  })
})
