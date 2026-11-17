/**
 * Host-side data surface for the UI panel (§9.2).
 *
 * The panel renders members, tasks, pending approvals, workspace files and
 * artifact links. Everything here is a projection over `OrcaNode`, the tracker
 * and the approval broker, already resolved for display (names, labels, links,
 * what can be cancelled): the client holds no business logic. Permission
 * decisions bypass the model on purpose, because the human is sitting at this
 * node (see §7.12) and should not need a tool round-trip.
 */

import { readdirSync } from "node:fs";

import { defaultDataRoot } from "../node/config.ts";
import type { DispatchEntry } from "../storage/stores.ts";
import { shortenNodeId } from "../security/identity.ts";
import { bindChoices, detectLocalEndpoints, isLoopbackEndpoint, normalizePeerUrl } from "../transport/net.ts";
import { isTerminal } from "../protocol/task.ts";
import type { PeerView, SelfRecord } from "../protocol/peer.ts";
import type { PermissionMode } from "../protocol/permission.ts";
import type { PermissionRequest } from "../protocol/grant.ts";
import type { PodTaskMetadata, TaskState, TaskView } from "../protocol/task.ts";
import type { ReasoningEffort } from "../protocol/model.ts";
import type { ExecutorKind, PanelPatch } from "../node/settings.ts";
import type { OrcaNode } from "../node/orca-node.ts";
import type { PodHandle } from "./lifecycle.ts";
import type { Tracker } from "./tracker.ts";
import { taskKey, type ApprovalBroker } from "./broker.ts";

/** One artifact attached to a task. */
export interface PodArtifact {
  name: string;
  blob_id: string;
  bytes: number;
  /** Signed direct link; null for tasks that live on another node (this node cannot sign for it). */
  url: string | null;
}

/** A node as the panel shows it; `busy_from` is the label of the origin it is busy for. */
export type PodPeer<T extends PeerView = PeerView> = T & { busy_from: string | null };

/** One hop of an approval chain, root first. */
export interface PodChainEntry {
  name: string;
  self: boolean;
}

/** One permission request waiting for the human (tracker and broker views merged). */
export interface PodApproval {
  /** `peer|task_id`: stable across polls. */
  id: string;
  peer: string;
  task_id: string;
  tool: string;
  /** Short preview of the requested arguments. */
  requested: string;
  /** Label of the node that actually needs the permission. */
  from: string;
  /** Approval path, this node first and the requesting node last. */
  chain: PodChainEntry[];
  /** DSH session that dispatched the task; null when only the tracker has seen the request. */
  agent_id: string | null;
}

/** One row of the task tables: a task this node runs, or one it dispatched. */
export interface PodTaskRow {
  id: string;
  /** Where details and cancel are addressed: this node's URL for local tasks, the target for dispatched ones. */
  peer: string;
  state: TaskState | "unknown";
  /** Origin of a local task, target of a dispatched one, as a display label. */
  who: string;
  who_title: string;
  at: string;
  artifacts: PodArtifact[];
  cancellable: boolean;
}

/** Everything the task detail dialog shows. */
export interface PodTaskDetail {
  task: TaskView;
  origin: string;
  dispatch: DispatchEntry | null;
  artifacts: PodArtifact[];
}

/** Workspace directories plus a shallow listing for the UI browser. */
export interface WorkspaceView {
  root: string;
  notes: string;
  state: string;
  /** Top-level files a later task will see in its appendix (`notes/<name>`). */
  notes_files: string[];
}

/** Advanced local controls the panel may edit; null means "not overridden". */
export interface PodAdvancedConfig {
  task_timeout_s: number | null;
  approval_timeout_s: number | null;
  result_max_bytes: number | null;
  max_workspace_bytes: number;
  max_workspace_files: number;
  allow_public_peers: boolean | null;
  allow_loopback_peers: boolean | null;
  permission_mode: PermissionMode | null;
  default_reasoning_effort: ReasoningEffort | null;
  executor: ExecutorKind | null;
}

/** Effective pod configuration as the panel may see it (never the password). */
export interface PodConfigView {
  /** True once a workgroup and its stored password exist (first-run setup done). */
  configured: boolean;
  workgroup_id: string;
  /** This node's orca node id (also the default display name), null before first start. */
  node_id: string | null;
  display_name: string | null;
  /** Listen address the node actually uses. */
  bind_host: string;
  port: number;
  /** Currently advertised dial URLs (the node's own list when it is running). */
  endpoints: string[];
  /** Dial URLs the form starts from: the usable advertised ones, else this machine's detected addresses. */
  suggested_endpoints: string[];
  /** Listen addresses the form offers. */
  bind_choices: string[];
  peers: string[];
  data_root: string;
  /** Local connection/timeout controls; null means the bundle default applies. */
  advanced: PodAdvancedConfig;
  password_set: boolean;
  running: boolean;
  error: string | null;
}

/** Read-only data surface plus approval actions. */
export interface PodAdmin {
  /** This node's own advertised record, or null while it is not running. */
  self(): PodPeer<SelfRecord> | null;
  /** Reachable members only: offline records are dropped. */
  members(): PodPeer[];
  /** Local tasks and dispatched tasks merged, newest first. */
  recent(limit: number): PodTaskRow[];
  /** Permission requests waiting for the human, one per task. */
  approvals(): PodApproval[];
  task(peer: string, taskId: string): Promise<PodTaskDetail>;
  approve(peer: string, taskId: string): Promise<TaskView>;
  deny(peer: string, taskId: string, reason?: string): Promise<TaskView>;
  cancel(peer: string, taskId: string): Promise<TaskView>;
  workspace(): WorkspaceView | null;
  /** Effective config plus setup state; the password itself is never returned. */
  config(): PodConfigView;
  /** Store a new password, persist the panel fields into the plugin config, and restart. */
  saveConfig(patch: PanelPatch): Promise<PodConfigView>;
  /** `join` one peer now and remember it for later starts. */
  connect(peer: string): Promise<PodConfigView>;
  /** Leave the workgroup: tell known peers and forget them locally. */
  disconnect(): Promise<PodConfigView>;
  /** Drop the workgroup, its stored password and the orca node identity (first-run wizard again). */
  reset(): Promise<PodConfigView>;
  /** Change notification; subscribes to both node events and tracker updates. */
  subscribe(listener: () => void): () => void;
}

const REQUESTED_PREVIEW_CHARS = 160;

/** List regular entries of one directory, sorted; missing paths yield []. */
function entries(dir: string): Array<{ name: string; is_dir: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, is_dir: entry.isDirectory() }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

const podOf = (view: TaskView): PodTaskMetadata => view.metadata?.pod ?? {};

const isActive = (state: string): boolean => state !== "unknown" && !isTerminal(state);

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > REQUESTED_PREVIEW_CHARS ? `${text.slice(0, REQUESTED_PREVIEW_CHARS - 1)}…` : text;
}

/** Display names for node ids and endpoint URLs, resolved against one roster snapshot. */
function labeller(current: OrcaNode | null): (key: string | undefined) => string {
  const peers: PeerView[] = current === null ? [] : [current.self(), ...current.members()];
  return (key) => {
    if (key === undefined || key.length === 0) return "-";
    const known = peers.find((peer) => peer.orca_node_id === key || peer.endpoints.includes(key));
    if (known !== undefined) return known.display_name;
    return URL.canParse(key) ? new URL(key).host : shortenNodeId(key);
  };
}

/** Approval path root first: this node, then each hop down to the node that needs the permission. */
function chainOf(request: PermissionRequest, self: SelfRecord | null, label: (key: string) => string): PodChainEntry[] {
  const chain: PodChainEntry[] = self === null ? [] : [{ name: label(self.orca_node_id), self: true }];
  for (const id of [request.requested_by, ...[...(request.upstream ?? [])].reverse()]) {
    const name = label(id);
    if (chain.at(-1)?.name !== name) chain.push({ name, self: false });
  }
  return chain;
}

/** Build the admin surface over one running orca node. */
/** A permission request waiting for the human, whoever saw it first. */
type PendingApproval = { peer: string; taskId: string; request: PermissionRequest; agentId: string | null };

export function createPodAdmin(handle: PodHandle, tracker: Tracker, broker: ApprovalBroker): PodAdmin {
  /** The node, or null while startup failed / has not completed yet. */
  function node(): OrcaNode | null {
    return handle.runtime.orcaNode;
  }

  function requireNode(): OrcaNode {
    const current = node();
    if (current === null) throw new Error("orca node is not running");
    return current;
  }

  /** The broker's parked prompts plus requests only the tracker has seen, one per task. */
  function waitingApprovals(): Map<string, PendingApproval> {
    const waiting = new Map<string, PendingApproval>();
    for (const prompt of broker.list()) {
      waiting.set(taskKey(prompt.peer, prompt.task_id), {
        peer: prompt.peer,
        taskId: prompt.task_id,
        request: prompt.request,
        agentId: prompt.agent_id,
      });
    }
    for (const tracked of tracker.list()) {
      const key = taskKey(tracked.peer, tracked.taskId);
      if (tracked.request !== null && !waiting.has(key)) {
        waiting.set(key, { peer: tracked.peer, taskId: tracked.taskId, request: tracked.request, agentId: null });
      }
    }
    return waiting;
  }

  /** A task this node runs: its origin is the root of the delegation tree. */
  function localRow(current: OrcaNode, label: (key: string | undefined) => string, view: TaskView): PodTaskRow {
    const origin = podOf(view).root_origin;
    return {
      id: view.id,
      peer: current.endpoints[0] ?? "",
      state: view.status.state,
      who: label(origin),
      who_title: origin ?? "",
      at: view.status.timestamp,
      artifacts: artifactsOf(current, view, true),
      cancellable: isActive(view.status.state),
    };
  }

  /** A task this node dispatched: its who is the target. */
  function dispatchRow(label: (key: string | undefined) => string, entry: DispatchEntry): PodTaskRow {
    return {
      id: entry.task_id,
      peer: entry.peer,
      state: entry.state,
      who: label(entry.peer),
      who_title: entry.peer,
      at: entry.updated_at,
      artifacts: [],
      cancellable: isActive(entry.state),
    };
  }

  function artifactsOf(current: OrcaNode, view: TaskView, local: boolean): PodArtifact[] {
    return (view.artifacts ?? []).map((artifact) => ({
      name: artifact.name,
      blob_id: artifact.artifactId,
      bytes: artifact.bytes,
      url: local ? current.blobLink(artifact.artifactId) : null,
    }));
  }

  function configView(): PodConfigView {
    const config = handle.config;
    const current = node();
    const self = current?.self() ?? null;
    const port = handle.runtime.port ?? config.port;
    const endpoints = current?.endpoints ?? [...config.endpoints];
    const usable = endpoints.filter((url) => !isLoopbackEndpoint(url));
    return {
      configured: handle.configured,
      workgroup_id: config.workgroup_id ?? "",
      node_id: self?.orca_node_id ?? null,
      display_name: self?.display_name ?? config.display_name ?? null,
      bind_host: config.bind_host,
      port,
      endpoints,
      suggested_endpoints: usable.length > 0 ? usable : detectLocalEndpoints(port),
      bind_choices: [...new Set([...bindChoices(port), config.bind_host])],
      peers: [...new Set([...config.peers, ...handle.rememberedPeers])],
      data_root: config.data_root ?? defaultDataRoot(),
      advanced: {
        task_timeout_s: config.task_timeout_s ?? null,
        approval_timeout_s: config.approval_timeout_s ?? null,
        result_max_bytes: config.result_max_bytes ?? null,
        max_workspace_bytes: config.max_workspace_bytes,
        max_workspace_files: config.max_workspace_files,
        allow_public_peers: config.allow_public_peers ?? null,
        allow_loopback_peers: config.allow_loopback_peers ?? null,
        permission_mode: config.permission_mode ?? null,
        default_reasoning_effort: config.default_reasoning_effort ?? null,
        executor: config.executor ?? null,
      },
      password_set: config.workgroup_password.length > 0,
      running: current !== null,
      error: handle.runtime.error === null ? null : handle.runtime.error.message,
    };
  }

  return {
    self() {
      const current = node();
      if (current === null) return null;
      const self = current.self();
      return { ...self, busy_from: self.busy === null ? null : labeller(current)(self.busy.origin_orca_node) };
    },
    members() {
      const current = node();
      if (current === null) return [];
      const label = labeller(current);
      return current
        .members()
        .filter((member) => member.state !== "offline")
        .map((member) => ({ ...member, busy_from: member.busy === null ? null : label(member.busy.origin_orca_node) }));
    },
    recent(limit) {
      const current = node();
      if (current === null) return [];
      const label = labeller(current);
      const tasks = current.listTasks(limit);
      const local = new Set(tasks.map((view) => view.id));
      const rows: PodTaskRow[] = [
        ...tasks.map((view) => localRow(current, label, view)),
        ...current
          .listDispatches()
          .slice(-limit)
          .filter((entry) => !local.has(entry.task_id))
          .map((entry) => dispatchRow(label, entry)),
      ];
      return rows.sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit);
    },
    approvals() {
      const current = node();
      const label = labeller(current);
      const self = current?.self() ?? null;
      return [...waitingApprovals()].map(([id, { peer, taskId, request, agentId }]) => {
        const chain = chainOf(request, self, label);
        return {
          id,
          peer,
          task_id: taskId,
          tool: request.tool,
          requested: preview(request.requested),
          from: chain.at(-1)?.name ?? "-",
          chain,
          agent_id: agentId,
        };
      });
    },
    async task(peer, taskId) {
      const current = requireNode();
      const task = await current.getTask(peer, taskId);
      // Only a task this node runs has its artifacts here.
      const local = current.endpoints.includes(peer);
      return {
        task,
        origin: labeller(current)(podOf(task).root_origin),
        dispatch: current.listDispatches().find((entry) => entry.task_id === task.id) ?? null,
        artifacts: artifactsOf(current, task, local),
      };
    },
    approve: (peer, taskId) => broker.approve(peer, taskId),
    deny: (peer, taskId, reason) => broker.deny(peer, taskId, reason),
    async cancel(peer, taskId) {
      return requireNode().cancelTask(peer, taskId);
    },
    workspace() {
      const paths = node()?.workspacePaths() ?? null;
      if (paths === null) return null;
      return {
        ...paths,
        notes_files: entries(paths.notes)
          .filter((entry) => !entry.is_dir)
          .map((entry) => entry.name),
      };
    },
    config: configView,
    async saveConfig(patch) {
      // The password goes to the DSH credential store and the other fields to the
      // plugin config; switching workgroups carries the current password over.
      await handle.reconfigure(patch);
      return configView();
    },
    async connect(peer) {
      await handle.addPeer(normalizePeerUrl(peer));
      return configView();
    },
    async disconnect() {
      await handle.disconnect();
      return configView();
    },
    async reset() {
      await handle.reset();
      return configView();
    },
    subscribe(listener) {
      const offNode = node()?.subscribe(listener) ?? (() => {});
      const offTracker = tracker.subscribe(listener);
      const offBroker = broker.subscribe(listener);
      return () => {
        offNode();
        offTracker();
        offBroker();
      };
    },
  };
}
