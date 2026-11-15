/**
 * Host-side data surface for the UI panel (§9.2).
 *
 * The panel renders members, local tasks, pending approvals, workspace files and
 * artifact links. Everything here is a thin projection over `OrcaNode` plus the
 * tracker; permission decisions bypass the model on purpose, because the human is
 * sitting at this node (see §7.12) and should not need a tool round-trip.
 */

import { readdirSync } from "node:fs"
import { join } from "node:path"

import { defaultDataRoot } from "../config.ts"
import { detectLocalEndpoints } from "../net.ts"
import { permissionRequestOf } from "../protocol.ts"
import type { DispatchEntry } from "../dispatches.ts"
import type { PeerView, PermissionMode, SelfRecord, TaskView } from "../protocol.ts"
import type { OrcaNode } from "../orca_node.ts"
import type { PodHandle } from "./lifecycle.ts"
import type { TrackedTask, Tracker } from "./tracker.ts"
import type { ApprovalPrompt, ApprovalPrompts } from "./prompts.ts"

/** One artifact attached to a task, with a directly usable download URL. */
export interface PodArtifact {
  name: string
  blob_id: string
  bytes: number
  /** Signed direct link, or null when this node advertises no endpoint yet. */
  url: string | null
}

/** Workspace directories plus a shallow listing for the UI browser. */
export interface WorkspaceView {
  root: string
  notes: string
  inputs: string
  state: string
  /** Top-level files a later task will see in its appendix (`notes/<name>`). */
  notes_files: string[]
  /** Per-task input directories, newest task ids last. */
  inputs_dirs: Array<{ task_id: string; files: string[] }>
}

/** Advanced local controls the panel may edit; null means "not overridden". */
export interface PodAdvancedConfig {
  task_timeout_s: number | null
  approval_timeout_s: number | null
  result_max_bytes: number | null
  max_input_files: number | null
  max_input_bytes: number | null
  allow_public_peers: boolean | null
  allow_loopback_peers: boolean | null
  permission_mode: PermissionMode | null
  executor: "echo" | "acp" | null
}

/** Effective pod configuration as the panel may see it (never the password). */
export interface PodConfigView {
  /** True once the panel finished setup (an override file exists). */
  configured: boolean
  workgroup_id: string
  /** This node's orca node id (also the default display name), null before first start. */
  node_id: string | null
  display_name: string | null
  port: number
  /** Currently advertised dial URLs (the node's own list when it is running). */
  endpoints: string[]
  /** Host addresses the panel offers as first-run endpoint suggestions. */
  detected_endpoints: string[]
  peers: string[]
  data_root: string
  /** Local connection/timeout controls; null means the bundle default applies. */
  advanced: PodAdvancedConfig
  password_set: boolean
  running: boolean
  error: string | null
}

/** Read-only data surface plus approval actions. */
export interface PodAdmin {
  /** This node's own advertised record, or null while it is not running. */
  self(): SelfRecord | null
  members(): PeerView[]
  tasks(limit?: number): TaskView[]
  dispatches(): DispatchEntry[]
  task(peer: string, taskId: string): Promise<TaskView>
  /** Watched remote tasks currently blocked on a permission request. */
  approvals(): TrackedTask[]
  /** `pod_approve` calls currently parked on a human answer. */
  prompts(): ApprovalPrompt[]
  approve(peer: string, taskId: string): Promise<TaskView>
  deny(peer: string, taskId: string, reason?: string): Promise<TaskView>
  cancel(peer: string, taskId: string): Promise<TaskView>
  artifacts(view: TaskView): PodArtifact[]
  workspace(): WorkspaceView | null
  /** Effective config plus setup state; the password itself is never returned. */
  config(): PodConfigView
  /** Persist a panel override and restart the orca node with the merged config. */
  saveConfig(patch: Record<string, unknown>): Promise<PodConfigView>
  /** `join` one peer now and remember it for later starts. */
  connect(peer: string): Promise<PodConfigView>
  /** Leave the workgroup: tell known peers and forget them locally. */
  disconnect(): Promise<PodConfigView>
  /** Delete the panel override and the persisted orca node identity. */
  reset(): Promise<PodConfigView>
  /** Change notification; subscribes to both node events and tracker updates. */
  subscribe(listener: () => void): () => void
}

/** List regular entries of one directory, sorted; missing paths yield []. */
function entries(dir: string): Array<{ name: string; is_dir: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, is_dir: entry.isDirectory() }))
      .sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

/** Poll until a parked `pod_approve` has resumed the task (or it settles). */
async function waitForResume(node: OrcaNode, peer: string, taskId: string): Promise<TaskView> {
  const deadline = Date.now() + 10_000
  let view = await node.getTask(peer, taskId)
  while (view.status.state === "input-required" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    view = await node.getTask(peer, taskId)
  }
  return view
}

/** Build the admin surface over one running orca node. */
export function createPodAdmin(
  handle: PodHandle,
  tracker: Tracker,
  options: { prompts?: ApprovalPrompts } = {},
): PodAdmin {
  /** The node, or null while startup failed / has not completed yet. */
  function node(): OrcaNode | null {
    return handle.runtime.orcaNode
  }

  function requireNode(): OrcaNode {
    const current = node()
    if (current === null) throw new Error("orca node is not running")
    return current
  }

  function configView(): PodConfigView {
    const config = handle.config
    const current = node()
    const self = current?.self() ?? null
    const port = handle.runtime.port ?? config.port
    return {
      configured: handle.uiConfigured,
      workgroup_id: config.workgroup_id,
      node_id: self?.orca_node_id ?? null,
      display_name: self?.display_name ?? config.display_name ?? null,
      port,
      endpoints: current?.endpoints ?? [...(config.endpoints ?? [])],
      detected_endpoints: detectLocalEndpoints(port),
      peers: [...config.peers],
      data_root: config.data_root ?? defaultDataRoot(),
      advanced: {
        task_timeout_s: config.task_timeout_s ?? null,
        approval_timeout_s: config.approval_timeout_s ?? null,
        result_max_bytes: config.result_max_bytes ?? null,
        max_input_files: config.max_input_files ?? null,
        max_input_bytes: config.max_input_bytes ?? null,
        allow_public_peers: config.allow_public_peers ?? null,
        allow_loopback_peers: config.allow_loopback_peers ?? null,
        permission_mode: config.permission_mode ?? null,
    executor: config.executor ?? null,
      },
      password_set: config.workgroup_password.length > 0,
      running: current !== null,
      error: handle.runtime.error === null ? null : handle.runtime.error.message,
    }
  }

  return {
    self() {
      return node()?.self() ?? null
    },
    members() {
      return node()?.members() ?? []
    },
    tasks(limit = 200) {
      return node()?.listTasks(limit) ?? []
    },
    dispatches() {
      return node()?.listDispatches() ?? []
    },
    async task(peer, taskId) {
      return requireNode().getTask(peer, taskId)
    },
    approvals() {
      return tracker.list().filter((tracked) => tracked.request !== null)
    },
    prompts() {
      return options.prompts?.list() ?? []
    },
    async approve(peer, taskId) {
      // A pending `pod_approve` call may be parked on this task; answering here
      // is the same decision the chat card / popup sends.
      const resolved = options.prompts?.resolve(peer, taskId, "allow") ?? false
      const current = requireNode()
      if (resolved) {
        return waitForResume(current, peer, taskId)
      }
      const view = await current.getTask(peer, taskId)
      if (permissionRequestOf(view) === null) throw new Error("task has no pending permission request")
      return current.approveTask(peer, view)
    },
    async deny(peer, taskId, reason = "denied from the UI") {
      const resolved = options.prompts?.resolve(peer, taskId, "deny") ?? false
      const current = requireNode()
      if (resolved) {
        return waitForResume(current, peer, taskId)
      }
      const view = await current.getTask(peer, taskId)
      if (permissionRequestOf(view) === null) throw new Error("task has no pending permission request")
      return current.denyTask(peer, view, reason)
    },
    async cancel(peer, taskId) {
      return requireNode().cancelTask(peer, taskId)
    },
    artifacts(view) {
      const current = node()
      return (view.artifacts ?? []).map((artifact) => ({
        name: artifact.name,
        blob_id: artifact.artifactId,
        bytes: artifact.bytes,
        url: current?.blobLink(artifact.artifactId) ?? null,
      }))
    },
    workspace() {
      const paths = node()?.workspacePaths() ?? null
      if (paths === null) return null
      const notesFiles = entries(paths.notes)
        .filter((entry) => !entry.is_dir)
        .map((entry) => entry.name)
      const inputsDirs = entries(paths.inputs)
        .filter((entry) => entry.is_dir)
        .map((entry) => ({
          task_id: entry.name,
          files: entries(join(paths.inputs, entry.name)).map((file) => file.name),
        }))
      return { ...paths, notes_files: notesFiles, inputs_dirs: inputsDirs }
    },
    config() {
      return configView()
    },
    async saveConfig(patch) {
      const rawPassword = patch["workgroup_password"]
      if (rawPassword !== undefined && (typeof rawPassword !== "string" || rawPassword.trim().length === 0)) {
        // A passwordless mesh is not supported: either set a password or omit
        // the field to keep the current one.
        throw new Error("a workgroup password is required; a passwordless mesh is not supported")
      }
      // Switching workgroups reuses the current password unless the panel sends a
      // new one: the password is a local secret, not a claim tied to one group.
      await handle.reconfigure(patch)
      return configView()
    },
    async connect(peer) {
      await handle.addPeer(normalizePeer(peer))
      return configView()
    },
    async disconnect() {
      await handle.disconnect()
      return configView()
    },
    async reset() {
      await handle.reset()
      return configView()
    },
    subscribe(listener) {
      const offNode = node()?.subscribe(listener) ?? (() => {})
      const offTracker = tracker.subscribe(listener)
      return () => {
        offNode()
        offTracker()
      }
    },
  }
}

/** Accept `host:port` shorthand and strip one trailing slash. */
export function normalizePeer(peer: string): string {
  const trimmed = peer.trim()
  if (trimmed.length === 0) throw new Error("peer address is required")
  const schemeMatch = /^(https?):\/\//i.exec(trimmed)
  const scheme = schemeMatch === null ? "http" : schemeMatch[1]!.toLowerCase()
  let rest = schemeMatch === null ? trimmed : trimmed.slice(schemeMatch[0].length)
  rest = rest.replace(/\/+$/, "")
  if (rest.length === 0) throw new Error(`peer address must include a host: ${trimmed}`)
  if (rest.includes("/") || rest.includes("?") || rest.includes("#")) {
    throw new Error(`peer address must be host[:port], without a path: ${trimmed}`)
  }
  let hostPart: string
  let portText: string | undefined
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]")
    if (close === -1) throw new Error(`invalid IPv6 peer address: ${trimmed}`)
    hostPart = rest.slice(1, close)
    const after = rest.slice(close + 1)
    if (after.length > 0) {
      if (!after.startsWith(":")) throw new Error(`invalid IPv6 peer address: ${trimmed}`)
      portText = after.slice(1)
    }
  } else {
    const parts = rest.split(":")
    if (parts.length > 2) {
      // A bare IPv6 literal has more than one colon and no explicit port.
      hostPart = rest
    } else if (parts.length === 2) {
      hostPart = parts[0]!
      portText = parts[1]
    } else {
      hostPart = rest
    }
  }
  if (hostPart.length === 0) throw new Error(`peer address must include a host: ${trimmed}`)
  const fallbackPort = schemeMatch === null ? 11811 : scheme === "https" ? 443 : 80
  const port = portText === undefined || portText.length === 0 ? fallbackPort : Number(portText)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid peer port: ${portText ?? ""}`)
  }
  const host = hostPart.includes(":") ? `[${hostPart}]` : hostPart
  return `${scheme}://${host}:${port}`
}


