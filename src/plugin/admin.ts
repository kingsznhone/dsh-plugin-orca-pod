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

import { permissionRequestOf } from "../protocol.ts"
import type { DispatchEntry } from "../dispatches.ts"
import type { PeerView, SelfRecord, TaskView } from "../protocol.ts"
import type { OrcaNode } from "../orca_node.ts"
import type { PodHandle } from "./lifecycle.ts"
import type { TrackedTask, Tracker } from "./tracker.ts"

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
  approve(peer: string, taskId: string): Promise<TaskView>
  deny(peer: string, taskId: string, reason?: string): Promise<TaskView>
  cancel(peer: string, taskId: string): Promise<TaskView>
  artifacts(view: TaskView): PodArtifact[]
  workspace(): WorkspaceView | null
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

/** Build the admin surface over one running orca node. */
export function createPodAdmin(handle: PodHandle, tracker: Tracker): PodAdmin {
  /** The node, or null while startup failed / has not completed yet. */
  function node(): OrcaNode | null {
    return handle.runtime.orcaNode
  }

  function requireNode(): OrcaNode {
    const current = node()
    if (current === null) throw new Error("orca node is not running")
    return current
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
    async approve(peer, taskId) {
      const current = requireNode()
      const view = await current.getTask(peer, taskId)
      if (permissionRequestOf(view) === null) throw new Error("task has no pending permission request")
      return current.approveTask(peer, view)
    },
    async deny(peer, taskId, reason = "denied from the UI") {
      const current = requireNode()
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
