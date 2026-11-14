import { describe, expect, it } from "vitest"

import { ConfigValidationError, validateConfigInput } from "../src/plugin/config.ts"
import type { PodHandle } from "../src/plugin/lifecycle.ts"
import { createPodTools } from "../src/plugin/tools.ts"
import { createTracker } from "../src/plugin/tracker.ts"
import * as plugin from "../src/plugin/index.ts"

function tool(result: ReturnType<typeof createPodTools>, name: string) {
  const found = result.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`missing tool ${name}`)
  return found
}

describe("plugin config", () => {
  it("applies defaults and keeps optional fields absent", () => {
    const config = validateConfigInput({ workgroup_id: "wg-a", workgroup_password: "pw" })
    expect(config).toEqual({ workgroup_id: "wg-a", workgroup_password: "pw", port: 11811, skill_injection: true, peers: [] })
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
      skill_injection: true,
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

describe("pod tools", () => {
  const handle: PodHandle = {
    ready: Promise.resolve(),
    runtime: { orcaNode: null, url: null, port: null, started_at: null, error: null },
    config: { workgroup_id: "wg-a", workgroup_password: "pw", port: 11811, skill_injection: false, peers: [] },
    uiConfigured: true,
    reconfigure: async () => {},
    addPeer: async () => {},
    disconnect: async () => {},
  }
  const tracker = createTracker(() => null, { intervalMs: 60_000 })
  const tools = createPodTools(handle, tracker)

  it("registers the five pod tools", () => {
    expect(tools.map((candidate) => candidate.name)).toEqual([
      "pod_send",
      "pod_status",
      "pod_cancel",
      "pod_approve",
      "pod_members",
    ])
  })

  it("documents asynchronous remote execution", () => {
    expect(tool(tools, "pod_send").description).toContain("asynchronously")
    expect(tool(tools, "pod_send").description).toContain("pod_status")
    expect(tool(tools, "pod_status").description).toContain("asynchronous")
    expect(tool(tools, "pod_cancel").description).toContain("pod_status")
  })

  it("renders results as JSON text", () => {
    const blocks = tool(tools, "pod_members").output.render({}, { self: { orca_node_id: "abc" } })
    expect(blocks).toEqual([
      { type: "text", text: JSON.stringify({ self: { orca_node_id: "abc" } }, null, 2) },
    ])
  })

  it("validates arguments before touching the orca node", async () => {
    await expect(tool(tools, "pod_send").execute({})).rejects.toThrow(/peer/)
    await expect(tool(tools, "pod_send").execute({ peer: "http://127.0.0.1:1" })).rejects.toThrow(/text/)
    await expect(tool(tools, "pod_status").execute({ peer: "http://127.0.0.1:1" })).rejects.toThrow(
      /task_id/,
    )
  })

  it("fails clearly when the orca node is not running", async () => {
    await expect(tool(tools, "pod_send").execute({ peer: "http://127.0.0.1:1", text: "hi" })).rejects.toThrow(
      /orca node is not running/,
    )
    await expect(tool(tools, "pod_members").execute({})).rejects.toThrow(/orca node is not running/)
  })
})
