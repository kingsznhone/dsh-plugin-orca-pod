import { describe, expect, it } from "vitest"

import { ConfigValidationError, validateConfigInput } from "../src/plugin/config.ts"
import type { DispatchEntry } from "../src/dispatches.ts"
import type { PodHandle } from "../src/plugin/lifecycle.ts"
import type { TaskView } from "../src/protocol.ts"
import { createPodTools } from "../src/plugin/tools.ts"
import type { TrackerAgent } from "../src/plugin/tracker.ts"
import { createTracker } from "../src/plugin/tracker.ts"
import * as plugin from "../src/plugin/index.ts"

function tool(result: ReturnType<typeof createPodTools>) {
  const found = result.find((candidate) => candidate.name === "orca_pod")
  if (found === undefined) throw new Error("missing tool orca_pod")
  return found
}

describe("plugin config", () => {
  it("applies defaults and keeps optional fields absent", () => {
    const config = validateConfigInput({ workgroup_id: "wg-a", workgroup_password: "pw" })
    expect(config).toEqual({ workgroup_id: "wg-a", workgroup_password: "pw", port: 11811, skill_injection: false, peers: [] })
  })

  it("keeps explicit values", () => {
    const config = validateConfigInput({
      workgroup_id: "wg-a",
      workgroup_password: "pw",
      display_name: "pod-a",
      port: 0,
      endpoints: ["http://127.0.0.1:9000"],
      data_root: "/tmp/orca",
      peers: ["http://127.0.0.1:11811"],
    })
    expect(config.port).toBe(0)
    expect(config.display_name).toBe("pod-a")
    expect(config.endpoints).toEqual(["http://127.0.0.1:9000"])
    expect(config.data_root).toBe("/tmp/orca")
    expect(config.peers).toEqual(["http://127.0.0.1:11811"])
  })

  it("allows starting without a workgroup so the panel can run its wizard", () => {
    expect(validateConfigInput({})).toEqual({
      workgroup_id: "",
      workgroup_password: "",
      port: 11811,
      skill_injection: false,
      peers: [],
    })
  })

  it("rejects an invalid workgroup id", () => {
    expect(() => validateConfigInput({ workgroup_id: "Bad ID", workgroup_password: "pw" })).toThrow(
      /workgroup_id/,
    )
  })

  it("rejects malformed peers", () => {
    expect(() =>
      validateConfigInput({
        workgroup_id: "wg-a",
        workgroup_password: "pw",
        peers: ["not a url"],
      }),
    ).toThrow(/peers/)
  })

  it("exposes the config as a Standard Schema", () => {
    const schema = plugin.Config["~standard"]
    expect(schema.version).toBe(1)
    const ok = schema.validate({ workgroup_id: "wg-a", workgroup_password: "pw" })
    expect("value" in ok).toBe(true)
    const bad = schema.validate({ workgroup_id: "Bad ID" })
    expect("issues" in bad && bad.issues.length > 0).toBe(true)
  })

  it("declares the tools hard dependency", () => {
    expect(plugin.inject).toEqual(["tools"])
  })
})

describe("orca_pod tool", () => {
  const handle: PodHandle = {
    ready: Promise.resolve(),
    runtime: { orcaNode: null, url: null, port: null, started_at: null, error: null },
    config: { workgroup_id: "wg-a", workgroup_password: "pw", port: 11811, skill_injection: false, peers: [] },
    uiConfigured: true,
    reconfigure: async () => {},
    addPeer: async () => {},
    disconnect: async () => {},
        reset: async () => {},
  }
  const tracker = createTracker(() => null, { intervalMs: 60_000 })
  const tools = createPodTools(handle, tracker)

  it("registers exactly one orca_pod tool", () => {
    expect(tools.map((candidate) => candidate.name)).toEqual(["orca_pod"])
  })

  it("documents the methods and asynchronous remote execution", () => {
    const description = tool(tools).description
    for (const method of ["send", "status", "cancel", "approve", "members", "connect"]) {
      expect(description).toContain(method)
    }
    expect(description).toContain("asynchronously")
    expect(description).toContain("task_id")
  })

  it("renders results as JSON text", () => {
    const blocks = tool(tools).output.render({}, { self: { orca_node_id: "abc" } })
    expect(blocks).toEqual([
      { type: "text", text: JSON.stringify({ self: { orca_node_id: "abc" } }, null, 2) },
    ])
  })

  it("requires a known method", async () => {
    await expect(tool(tools).execute({})).rejects.toThrow(/method/)
    await expect(tool(tools).execute({ method: "nope" })).rejects.toThrow(/method must be one of/)
  })

  it("validates each method's arguments before touching the orca node", async () => {
    await expect(tool(tools).execute({ method: "send" })).rejects.toThrow(/peer/)
    await expect(tool(tools).execute({ method: "send", peer: "http://127.0.0.1:1" })).rejects.toThrow(/text/)
    await expect(tool(tools).execute({ method: "status", peer: "http://127.0.0.1:1" })).rejects.toThrow(
      /task_id/,
    )
    await expect(tool(tools).execute({ method: "cancel", peer: "http://127.0.0.1:1" })).rejects.toThrow(
      /task_id/,
    )
    await expect(tool(tools).execute({ method: "connect" })).rejects.toThrow(/peer/)
    await expect(tool(tools).execute({ method: "connect", peer: "not a url" })).rejects.toThrow(/http/)
    await expect(
      tool(tools).execute({ method: "approve", peer: "http://127.0.0.1:1", task_id: "t" }),
    ).rejects.toThrow(/decision/)
    await expect(
      tool(tools).execute({ method: "approve", peer: "http://127.0.0.1:1", task_id: "t", decision: "maybe" }),
    ).rejects.toThrow(/decision must be "allow" or "deny"/)
  })

  it("rejects a malformed model selector before touching the orca node", async () => {
    await expect(
      tool(tools).execute({ method: "send", peer: "http://127.0.0.1:1", text: "hi", model: "nope" }),
    ).rejects.toThrow(/provider\/model/)
  })

  it("fails clearly when the orca node is not running", async () => {
    await expect(tool(tools).execute({ method: "send", peer: "http://127.0.0.1:1", text: "hi" })).rejects.toThrow(
      /orca node is not running/,
    )
    await expect(tool(tools).execute({ method: "members" })).rejects.toThrow(/orca node is not running/)
    await expect(tool(tools).execute({ method: "connect", peer: "127.0.0.1:11811" })).rejects.toThrow(
      /orca node is not running/,
    )
  })

  it("inherits the dispatching session's permission mode when send omits one", async () => {
    const sent: unknown[] = []
    const fakeNode = {
      sendTask: async (_peer: string, input: unknown) => {
        sent.push(input)
        return { id: "task-1", status: { state: "submitted" } }
      },
    } as unknown as import("../src/orca_node.ts").OrcaNode
    const handleForSend = {
      ready: Promise.resolve(),
      runtime: { orcaNode: fakeNode, url: null, port: null, started_at: null, error: null },
      config: { workgroup_id: "wg-a", workgroup_password: "pw", port: 11811, skill_injection: false, peers: [] },
      uiConfigured: true,
      reconfigure: async () => {},
      addPeer: async () => {},
      disconnect: async () => {},
      reset: async () => {},
    } as unknown as PodHandle
    const sendTools = createPodTools(handleForSend, tracker, {
      sessionPermissionMode: (exec) => (exec?.agent?.session === undefined ? undefined : "workspace-write"),
    })
    const agent = {
      id: "session-1",
      status: "running" as const,
      session: {},
      inject: () => {},
      followup: () => {},
    }
    await tool(sendTools).execute({ method: "send", peer: "http://127.0.0.1:11811", text: "hi" }, { agent })
    const inherited = sent[0] as { metadata?: { pod?: Record<string, unknown> } }
    expect(inherited.metadata?.pod?.["permission_mode"]).toBe("workspace-write")

    await tool(sendTools).execute(
      { method: "send", peer: "http://127.0.0.1:11811", text: "hi", permission_mode: "read-only" },
      { agent },
    )
    const explicit = sent[1] as { metadata?: { pod?: Record<string, unknown> } }
    expect(explicit.metadata?.pod?.["permission_mode"]).toBe("read-only")
  })

  it("reads sandbox modes from the session's permission preset", () => {
    const session = {}
    const agent = {
      id: "session-1",
      status: "running" as const,
      session,
      inject: () => {},
      followup: () => {},
    }
    const presets = {
      permissionState: (target: unknown) =>
        target === session ? { sandbox: "danger-full-access", approval: "never", preset: "auto" } : {},
    }
    expect(plugin.sessionSandboxMode(presets, { agent })).toBe("danger-full-access")
    expect(plugin.sessionSandboxMode(undefined, { agent })).toBeUndefined()
    expect(plugin.sessionSandboxMode(presets, undefined)).toBeUndefined()
    expect(
      plugin.sessionSandboxMode({ permissionState: () => ({ sandbox: "custom" }) }, { agent }),
    ).toBeUndefined()
  })

  it("joins a peer and returns the refreshed members", async () => {
    const seen: string[] = []
    const fakeNode = {
      members: () => [],
      membersDigest: () => "digest",
    } as unknown as import("../src/orca_node.ts").OrcaNode
    const handleForConnect = {
      ready: Promise.resolve(),
      runtime: { orcaNode: fakeNode, url: null, port: null, started_at: null, error: null },
      config: { workgroup_id: "wg-a", workgroup_password: "pw", port: 11811, skill_injection: false, peers: [] },
      uiConfigured: true,
      reconfigure: async () => {},
      addPeer: async (peer: string) => {
        seen.push(peer)
      },
      disconnect: async () => {},
      reset: async () => {},
    } as unknown as PodHandle
    const connectTools = createPodTools(handleForConnect, tracker)
    const result = await tool(connectTools).execute({ method: "connect", peer: "192.168.1.20" })
    expect(seen).toEqual(["http://192.168.1.20:11811"])
    expect(result).toEqual({
      peer: "http://192.168.1.20:11811",
      members: [],
      members_digest: "digest",
    })
  })
})

describe("tracker recovery (8.3)", () => {
  function dispatch(taskId: string, state: string, agentId?: string): DispatchEntry {
    const now = new Date().toISOString()
    return {
      task_id: taskId,
      peer: "http://127.0.0.1:9",
      state,
      created_at: now,
      updated_at: now,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
    }
  }

  function view(taskId: string): TaskView {
    return {
      kind: "task",
      id: taskId,
      contextId: taskId,
      status: { state: "working", timestamp: new Date().toISOString() },
    }
  }

  it("resumes only non-terminal dispatches with a live dispatching agent", async () => {
    const agent: TrackerAgent = {
      id: "live-session",
      status: "idle",
      inject: () => {},
      followup: () => {},
    }
    const tracker = createTracker(
      () => ({
        async getTask(_peer: string, taskId: string): Promise<TaskView> {
          return view(taskId)
        },
      }),
      { intervalMs: 1000, coalesceMs: 1000 },
    )
    try {
      const restored = plugin.restoreTrackedDispatches(
        tracker,
        [
          dispatch("running", "working", "live-session"),
          dispatch("parked", "input-required", "live-session"),
          dispatch("done", "completed", "live-session"),
          dispatch("unattributed", "working"),
          dispatch("orphaned", "working", "gone-session"),
        ],
        (agentId) => (agentId === "live-session" ? agent : undefined),
      )
      expect(restored).toBe(2)
      expect(tracker.size()).toBe(2)
    } finally {
      tracker.stop()
    }
  })
})
