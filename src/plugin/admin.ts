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

import { SANDBOX_MODES } from "@deepseek-ai/dsh-sandbox-policy";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { OpenedBlob } from "../core/blobs.ts";
import type { DispatchEntry, PodTaskMetadata, TaskState, TaskView } from "../task/wire.ts";
import { shortenNodeId } from "../core/identity.ts";
import { bindChoices, detectLocalEndpoints, isLoopbackEndpoint, normalizePeerUrl } from "../core/net.ts";
import { isTerminal } from "../task/wire.ts";
import type { OrcaNodeId, PeerView, SelfRecord } from "../core/wire/peer.ts";
import type { PermissionRequest } from "../core/wire/grant.ts";
import type { LlmReasoningEffortInfo, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ExecutorKind } from "../executor/kinds.ts";
import type { PanelPatch } from "../node/settings.ts";
import type { OrcaNode } from "../node/orca-node.ts";
import type { ModelCatalogFeed } from "./catalog.ts";
import type { PodLifecycle } from "./lifecycle.ts";
import type { Tracker } from "./tracker.ts";
import { taskKey, type ApprovalBroker } from "./broker.ts";

/** One artifact attached to a task: a file its node published (§5.6). */
export interface PodArtifact {
  name: string;
  blob_id: string;
  bytes: number;
  /** The node that published it; null when this node cannot tell which member runs the task. */
  node: string | null;
}

/** A node as the panel shows it; `busy_from` is the label of the origin it is busy for. */
export type PodPeer<T extends PeerView = PeerView> = T & { busy_from: string | null };

/** One permission request waiting for the human (tracker and broker views merged). */
export interface PodApproval {
  /** `peer|task_id`: stable across polls. */
  id: string;
  peer: string;
  task_id: string;
  tool: string;
  /** Short preview of the requested arguments. */
  requested: string;
  /** Label of the node that needs the permission. */
  from: string;
  /** The task's mode now, and the mode it asks to continue with until it ends. */
  current_mode: SandboxMode;
  requested_mode: SandboxMode;
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
  permission_mode: SandboxMode | null;
  default_reasoning_effort: ReasoningEffortId | null;
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
  /** The permission modes this DSH accepts, in rank order (read from DSH itself). */
  permission_modes: readonly SandboxMode[];
  /** The efforts the host's default model offers, least to most (read from DSH's `llm`). */
  reasoning_efforts: readonly LlmReasoningEffortInfo[];
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

/** Panel state snapshot: everything the status page and the approval cards render in one poll. */
export interface PodState {
  self: PodPeer<SelfRecord> | null;
  config: PodConfigView;
  members: PodPeer[];
  mesh: { reachable: number };
  approvals: PodApproval[];
  approval_count: number;
  recent: PodTaskRow[];
  workspace: WorkspaceView | null;
}

const REQUESTED_PREVIEW_CHARS = 160;

/** Rows of the status page's recent-tasks table. */
const RECENT_LIMIT = 5;

/** Display names for node ids and endpoint URLs, resolved against one roster snapshot. */
class RosterLabels {
  private readonly peers: PeerView[];

  constructor(node: OrcaNode | null) {
    this.peers = node === null ? [] : [node.profile.record(), ...node.membership.list()];
  }

  label(key: string | undefined): string {
    if (key === undefined || key.length === 0) return "-";
    const known = this.peers.find((peer) => peer.orca_node_id === key || peer.endpoints.includes(key));
    if (known !== undefined) return known.display_name;
    return URL.canParse(key) ? new URL(key).host : shortenNodeId(key);
  }
}

/** A permission request waiting for the human, whoever saw it first. */
type PendingApproval = { peer: string; taskId: string; request: PermissionRequest; agentId: string | null };

/**
 * The data surface of the UI panel plus the approval actions, over one pod
 * lifecycle: its running node, the tracker and the approval broker.
 */
export class PodAdmin {
  constructor(
    private readonly lifecycle: PodLifecycle,
    private readonly tracker: Tracker,
    private readonly broker: ApprovalBroker,
    /** The host's model catalog; without one the panel offers no effort to pick. */
    private readonly catalog: ModelCatalogFeed,
  ) {}

  /** This node's own advertised record, or null while it is not running. */
  self(): PodPeer<SelfRecord> | null {
    const current = this.lifecycle.run?.node;
    if (current === undefined) return null;
    const self = current.profile.record();
    return {
      ...self,
      busy_from: self.busy === null ? null : new RosterLabels(current).label(self.busy.origin_orca_node),
    };
  }

  /** Reachable members only: offline records are dropped. */
  members(): PodPeer[] {
    const current = this.lifecycle.run?.node;
    if (current === undefined) return [];
    const labels = new RosterLabels(current);
    return current.membership
      .list()
      .filter((member) => member.state !== "offline")
      .map((member) => ({
        ...member,
        busy_from: member.busy === null ? null : labels.label(member.busy.origin_orca_node),
      }));
  }

  /** Local tasks and dispatched tasks merged, newest first. */
  recent(limit: number): PodTaskRow[] {
    const current = this.lifecycle.run?.node;
    if (current === undefined) return [];
    const labels = new RosterLabels(current);
    const tasks = current.tasks.list(limit);
    const local = new Set(tasks.map((view) => view.id));
    const rows: PodTaskRow[] = [
      ...tasks.map((view) => PodAdmin.localRow(current, labels, view)),
      ...current.delegation.log
        .list()
        .slice(-limit)
        .filter((entry) => !local.has(entry.task_id))
        .map((entry) => PodAdmin.dispatchRow(labels, entry)),
    ];
    return rows.sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit);
  }

  /** Everything the status page and the approval cards render, in one poll. */
  state(): PodState {
    const members = this.members();
    const approvals = this.approvals();
    return {
      self: this.self(),
      config: this.config(),
      members,
      mesh: { reachable: members.length },
      approvals,
      approval_count: approvals.length,
      recent: this.recent(RECENT_LIMIT),
      workspace: this.workspace(),
    };
  }

  /** Permission requests waiting for the human, one per task. */
  approvals(): PodApproval[] {
    const labels = new RosterLabels(this.lifecycle.run?.node ?? null);
    return [...this.waitingApprovals()].map(([id, { peer, taskId, request, agentId }]) => ({
      id,
      peer,
      task_id: taskId,
      tool: request.tool,
      requested: PodAdmin.preview(request.requested),
      from: labels.label(request.requested_by),
      current_mode: request.current_mode,
      requested_mode: request.requested_mode,
      agent_id: agentId,
    }));
  }

  async task(peer: string, taskId: string): Promise<PodTaskDetail> {
    const current = await this.node();
    const task = await current.delegation.getTask(peer, taskId);
    return {
      task,
      origin: new RosterLabels(current).label(PodAdmin.podOf(task).origin_orca_node),
      dispatch: current.delegation.log.list().find((entry) => entry.task_id === task.id) ?? null,
      artifacts: PodAdmin.artifactsOf(task, current.client.idOf(peer)),
    };
  }

  approve(peer: string, taskId: string): Promise<TaskView> {
    return this.broker.approve(peer, taskId);
  }

  deny(peer: string, taskId: string, reason?: string): Promise<TaskView> {
    return this.broker.deny(peer, taskId, reason);
  }

  async cancel(peer: string, taskId: string): Promise<TaskView> {
    return (await this.node()).delegation.cancelTask(peer, taskId);
  }

  workspace(): WorkspaceView | null {
    const workspace = this.lifecycle.run?.node.workspace;
    if (workspace === undefined) return null;
    return { root: workspace.root, notes: workspace.notes, state: workspace.state, notes_files: workspace.noteFiles() };
  }

  /** A file a member published, fetched by this node for the panel (§5.6). */
  async blob(node: OrcaNodeId, blobId: string): Promise<OpenedBlob> {
    return (await this.node()).blobs.fetch(node, blobId);
  }

  /** Effective config plus setup state; the password itself is never returned. */
  config(): PodConfigView {
    const { lifecycle } = this;
    const config = lifecycle.settings;
    const { run, status } = lifecycle;
    const current = run?.node ?? null;
    const self = current?.profile.record() ?? null;
    const port = run?.port ?? config.port;
    const endpoints = [...(current?.profile.endpoints ?? config.endpoints)];
    const usable = endpoints.filter((url) => !isLoopbackEndpoint(url));
    return {
      configured: lifecycle.configured,
      workgroup_id: config.workgroup_id ?? "",
      node_id: self?.orca_node_id ?? null,
      display_name: self?.display_name ?? config.display_name ?? null,
      bind_host: config.bind_host,
      port,
      endpoints,
      suggested_endpoints: usable.length > 0 ? usable : detectLocalEndpoints(port),
      permission_modes: SANDBOX_MODES,
      reasoning_efforts: this.catalog.current().reasoningEfforts,
      bind_choices: [...new Set([...bindChoices(port), config.bind_host])],
      peers: [...new Set([...config.peers, ...lifecycle.rememberedPeers])],
      data_root: config.data_root,
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
      password_set: lifecycle.passwordSet,
      running: current !== null,
      error: status.kind === "failed" ? status.error.message : null,
    };
  }

  /** Store a new password, persist the panel fields into the plugin config, and restart. */
  async saveConfig(patch: PanelPatch): Promise<PodConfigView> {
    // The password goes to the DSH credential store and the other fields to the
    // plugin config; switching workgroups carries the current password over.
    await this.lifecycle.reconfigure(patch);
    return this.config();
  }

  /** `join` one peer now and remember it for later starts. */
  async connect(peer: string): Promise<PodConfigView> {
    await this.lifecycle.addPeer(normalizePeerUrl(peer));
    return this.config();
  }

  /** Leave the workgroup: tell known peers and forget them locally. */
  async disconnect(): Promise<PodConfigView> {
    await this.lifecycle.disconnect();
    return this.config();
  }

  /** Drop the workgroup, its stored password and the orca node identity (first-run wizard again). */
  async reset(): Promise<PodConfigView> {
    await this.lifecycle.reset();
    return this.config();
  }

  /** The node of the current run, once any restart in progress has finished; fails when there is none. */
  private async node(): Promise<OrcaNode> {
    await this.lifecycle.settled();
    return this.lifecycle.requireRun().node;
  }

  /** The broker's parked prompts plus requests only the tracker has seen, one per task. */
  private waitingApprovals(): Map<string, PendingApproval> {
    const waiting = new Map<string, PendingApproval>();
    for (const prompt of this.broker.list()) {
      waiting.set(taskKey(prompt.peer, prompt.task_id), {
        peer: prompt.peer,
        taskId: prompt.task_id,
        request: prompt.request,
        agentId: prompt.agent_id,
      });
    }
    for (const tracked of this.tracker.list()) {
      const key = taskKey(tracked.peer, tracked.taskId);
      if (tracked.request !== null && !waiting.has(key)) {
        waiting.set(key, { peer: tracked.peer, taskId: tracked.taskId, request: tracked.request, agentId: null });
      }
    }
    return waiting;
  }
  private static podOf(view: TaskView): PodTaskMetadata {
    return view.metadata?.pod ?? {};
  }

  private static isActive(state: string): boolean {
    return state !== "unknown" && !isTerminal(state);
  }

  private static preview(value: unknown): string {
    const text = JSON.stringify(value) ?? "";
    return text.length > REQUESTED_PREVIEW_CHARS ? `${text.slice(0, REQUESTED_PREVIEW_CHARS - 1)}…` : text;
  }

  private static artifactsOf(view: TaskView, node: OrcaNodeId | undefined): PodArtifact[] {
    return (view.artifacts ?? []).map((artifact) => ({
      name: artifact.name,
      blob_id: artifact.artifactId,
      bytes: artifact.bytes,
      node: node ?? null,
    }));
  }

  /** A task this node dispatched: its who is the target. */
  private static dispatchRow(labels: RosterLabels, entry: DispatchEntry): PodTaskRow {
    return {
      id: entry.task_id,
      peer: entry.peer,
      state: entry.state,
      who: labels.label(entry.peer),
      who_title: entry.peer,
      at: entry.updated_at,
      artifacts: [],
      cancellable: PodAdmin.isActive(entry.state),
    };
  }

  /** A task this node runs: its who is the node that dispatched it. */
  private static localRow(current: OrcaNode, labels: RosterLabels, view: TaskView): PodTaskRow {
    const origin = PodAdmin.podOf(view).origin_orca_node;
    return {
      id: view.id,
      peer: current.profile.endpoints[0] ?? "",
      state: view.status.state,
      who: labels.label(origin),
      who_title: origin ?? "",
      at: view.status.timestamp,
      artifacts: PodAdmin.artifactsOf(view, current.orcaNodeId),
      cancellable: PodAdmin.isActive(view.status.state),
    };
  }
}
