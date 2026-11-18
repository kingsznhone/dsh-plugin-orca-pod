/**
 * The model behind the UI panel (§9.2): what it shows and what it can do.
 *
 * The panel renders members, tasks, pending approvals, workspace files and
 * artifact links. Everything here is a projection over the pod's running node
 * and the approval broker, already resolved for display (names, labels, links,
 * what can be cancelled): the client holds no business logic. The shapes it
 * answers with are the contract in `panel-api.ts`. Permission
 * decisions bypass the model on purpose, because the human is sitting at this
 * node (see §7.12) and should not need a tool round-trip.
 */

import { SANDBOX_MODES } from "@deepseek-ai/dsh-sandbox-policy";
import type { OpenedBlob } from "../core/blobs.ts";
import type { DispatchEntry, PodTaskMetadata, TaskView } from "../task/wire.ts";
import { shortenNodeId } from "../core/identity.ts";
import { bindChoices, detectLocalEndpoints, isLoopbackEndpoint, normalizePeerUrl } from "../core/net.ts";
import { isTerminal } from "../task/wire.ts";
import type { OrcaNodeId, PeerView, SelfRecord } from "../core/wire/peer.ts";
import type { PanelPatch } from "../node/settings.ts";
import type { OrcaNode } from "../node/orca-node.ts";
import type { ModelCatalogFeed } from "./catalog.ts";
import type { Pod } from "./pod.ts";
import { taskKey, type ApprovalBroker } from "./broker.ts";
import type {
  PodApproval,
  PodArtifact,
  PodConfigView,
  PodPeer,
  PodState,
  PodTaskDetail,
  PodTaskRow,
  WorkspaceView,
} from "./panel-api.ts";

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

/**
 * What the UI panel shows and does, over one pod (its running node) and the
 * approval broker.
 */
export class PanelModel {
  constructor(
    private readonly pod: Pod,
    private readonly broker: ApprovalBroker,
    /** The host's model catalog; without one the panel offers no effort to pick. */
    private readonly catalog: ModelCatalogFeed,
  ) {}

  /** This node's own advertised record, or null while it is not running. */
  self(): PodPeer<SelfRecord> | null {
    const current = this.pod.run?.node;
    if (current === undefined) return null;
    const self = current.profile.record();
    return {
      ...self,
      busy_from: self.busy === null ? null : new RosterLabels(current).label(self.busy.origin_orca_node),
    };
  }

  /** Reachable members only: offline records are dropped. */
  members(): PodPeer[] {
    const current = this.pod.run?.node;
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
    const current = this.pod.run?.node;
    if (current === undefined) return [];
    const labels = new RosterLabels(current);
    const tasks = current.tasks.list(limit);
    const local = new Set(tasks.map((view) => view.id));
    const rows: PodTaskRow[] = [
      ...tasks.map((view) => PanelModel.localRow(current, labels, view)),
      ...current.delegation.log
        .list()
        .slice(-limit)
        .filter((entry) => !local.has(entry.task_id))
        .map((entry) => PanelModel.dispatchRow(labels, entry)),
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
    const labels = new RosterLabels(this.pod.run?.node ?? null);
    return this.broker.list().map(({ peer, task_id, request, agent_id }) => ({
      id: taskKey(peer, task_id),
      peer,
      task_id,
      tool: request.tool,
      requested: PanelModel.preview(request.requested),
      from: labels.label(request.requested_by),
      current_mode: request.current_mode,
      requested_mode: request.requested_mode,
      agent_id,
    }));
  }

  async task(peer: string, taskId: string): Promise<PodTaskDetail> {
    const current = await this.node();
    const task = await current.delegation.getTask(peer, taskId);
    return {
      task,
      origin: new RosterLabels(current).label(PanelModel.podOf(task).origin_orca_node),
      dispatch: current.delegation.log.list().find((entry) => entry.task_id === task.id) ?? null,
      artifacts: PanelModel.artifactsOf(task, current.client.idOf(peer)),
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
    const workspace = this.pod.run?.node.workspace;
    if (workspace === undefined) return null;
    return { root: workspace.root, notes: workspace.notes, state: workspace.state, notes_files: workspace.noteFiles() };
  }

  /** A file a member published, fetched by this node for the panel (§5.6). */
  async blob(node: OrcaNodeId, blobId: string): Promise<OpenedBlob> {
    return (await this.node()).blobs.fetch(node, blobId);
  }

  /** Effective config plus setup state; the password itself is never returned. */
  config(): PodConfigView {
    const { pod } = this;
    const config = pod.settings;
    const { run, status } = pod;
    const current = run?.node ?? null;
    const self = current?.profile.record() ?? null;
    const port = run?.port ?? config.port;
    const endpoints = [...(current?.profile.endpoints ?? config.endpoints)];
    const usable = endpoints.filter((url) => !isLoopbackEndpoint(url));
    return {
      configured: pod.configured,
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
      peers: [...new Set([...config.peers, ...pod.rememberedPeers])],
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
      password_set: pod.passwordSet,
      running: current !== null,
      error: status.kind === "failed" ? status.error.message : null,
    };
  }

  /** Store a new password, persist the panel fields into the plugin config, and restart. */
  async saveConfig(patch: PanelPatch): Promise<PodConfigView> {
    // The password goes to the DSH credential store and the other fields to the
    // plugin config; switching workgroups carries the current password over.
    await this.pod.reconfigure(patch);
    return this.config();
  }

  /** `join` one peer now and remember it for later starts. */
  async connect(peer: string): Promise<PodConfigView> {
    await this.pod.addPeer(normalizePeerUrl(peer));
    return this.config();
  }

  /** Leave the workgroup: tell known peers and forget them locally. */
  async disconnect(): Promise<PodConfigView> {
    await this.pod.disconnect();
    return this.config();
  }

  /** Drop the workgroup, its stored password and the orca node identity (first-run wizard again). */
  async reset(): Promise<PodConfigView> {
    await this.pod.reset();
    return this.config();
  }

  /** The node of the current run, once any restart in progress has finished; fails when there is none. */
  private async node(): Promise<OrcaNode> {
    await this.pod.settled();
    return this.pod.requireRun().node;
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
      cancellable: PanelModel.isActive(entry.state),
    };
  }

  /** A task this node runs: its who is the node that dispatched it. */
  private static localRow(current: OrcaNode, labels: RosterLabels, view: TaskView): PodTaskRow {
    const origin = PanelModel.podOf(view).origin_orca_node;
    return {
      id: view.id,
      peer: current.profile.endpoints[0] ?? "",
      state: view.status.state,
      who: labels.label(origin),
      who_title: origin ?? "",
      at: view.status.timestamp,
      artifacts: PanelModel.artifactsOf(view, current.orcaNodeId),
      cancellable: PanelModel.isActive(view.status.state),
    };
  }
}
