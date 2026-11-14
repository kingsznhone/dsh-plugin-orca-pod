import { describe, expect, it } from "vitest"

import type { TaskState, TaskView } from "../src/protocol.ts"
import type { AgentNotice, ToolAgent } from "../src/plugin/dsh.ts"
import { createTracker, taskNoticeLine } from "../src/plugin/tracker.ts"

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
    expect(notice).toContain("pod_approve")
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
