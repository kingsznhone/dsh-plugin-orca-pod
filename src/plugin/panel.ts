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
import { parseBlobRef, type OpenedBlob } from "../core/blobs.ts";
import { type DispatchEntry, type PodTaskMetadata, type TaskView, isTerminal, messageText } from "../task/wire.ts";
import { shortenNodeId } from "../core/identity.ts";
import { detectLocalEndpoints, normalizePeerUrl } from "../core/net.ts";
import { isLoopbackEndpoint, type Pod } from "./pod.ts";
import type { OrcaNodeId } from "../core/ids.ts";
import type { PeerView, SelfRecord } from "../mesh/wire.ts";
import type { PanelPatch } from "../node/settings.ts";
import type { Orca } from "../node/orca.ts";
import type { ModelCatalogFeed } from "./catalog.ts";
import { taskKey, type ApprovalBroker } from "./broker.ts";
import type {
  PodApproval,
  PodFileRef,
  PodConfigView,
  PodPeer,
  PodState,
  PodTaskDetail,
  PodTaskRow,
  WorkspaceView,
} from "./panel-api.ts";

const REQUESTED_PREVIEW_CHARS = 160;

/** A file name in a task's text: an orca node id (43 base64url chars), a slash, a sha256 (§5.6). */
const FILE_NAME = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}\/[0-9a-f]{64}(?![0-9a-f])/g;
/** Rows of the status page's recent-tasks table. */
const RECENT_LIMIT = 5;

/** Display names for node ids and endpoint URLs, resolved against one roster snapshot. */
class RosterLabels {
  private readonly peers: PeerView[];

  constructor(orca: Orca | null) {
    this.peers = orca === null ? [] : orca.mesh.list().map((node) => node.view());
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

  /** Local tasks and dispatched tasks merged, newest first. */
  recent(limit: number): PodTaskRow[] {
    const current = this.pod.run?.orca;
    if (current === undefined) return [];
    const labels = new RosterLabels(current);
    const tasks = current.tasks.list(limit);
    const local = new Set(tasks.map((view) => view.id));
    const rows: PodTaskRow[] = [
      ...tasks.map((view) => PanelModel.localRow(current, labels, view)),
      ...current.dispatches
        .list()
        .slice(-limit)
        .filter((entry) => !local.has(entry.task_id))
        .map((entry) => PanelModel.dispatchRow(labels, entry)),
    ];
    return rows.sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit);
  }

  /** Everything the status page and the approval cards render, in one poll. */
  async state(): Promise<PodState> {
    return {
      self: this.self(),
      config: await this.config(),
      members: this.members(),
      approvals: this.approvals(),
      recent: this.recent(RECENT_LIMIT),
      workspace: this.workspace(),
    };
  }

  async task(ref: string, taskId: string): Promise<PodTaskDetail> {
    const current = await this.pod.orca();
    const node = current.mesh.resolve(ref);
    const task = await node.getTask(taskId);
    return {
      task,
      origin: new RosterLabels(current).label(PanelModel.podOf(task).origin_orca_node),
      dispatch: current.dispatches.list().find((entry) => entry.task_id === task.id) ?? null,
      files: PanelModel.filesOf(task),
    };
  }

  approve(peer: string, taskId: string): Promise<TaskView> {
    return this.broker.approve(peer, taskId);
  }

  deny(peer: string, taskId: string, reason?: string): Promise<TaskView> {
    return this.broker.deny(peer, taskId, reason);
  }

  async cancel(ref: string, taskId: string): Promise<TaskView> {
    return (await this.pod.orca()).mesh.resolve(ref).cancelTask(taskId);
  }

  /** A file a member published, fetched by this node for the panel (§5.6). */
  async blob(node: OrcaNodeId, blobId: string): Promise<OpenedBlob> {
    return (await this.pod.orca()).mesh.require(node).fetchBlob(blobId);
  }

  /** Effective config plus setup state; the password itself is never returned. */
  async config(): Promise<PodConfigView> {
    const { pod } = this;
    const { acp: _acp, ...settings } = pod.settings;
    const { run, status } = pod;
    const current = run?.orca ?? null;
    const self = current?.mesh.self.selfRecord() ?? null;
    const port = run?.port ?? settings.port;
    const endpoints = [...(current?.mesh.self.endpoints ?? settings.endpoints)];
    const usable = endpoints.filter((url) => !isLoopbackEndpoint(url));
    return {
      configured: pod.configured,
      settings,
      node_id: self?.orca_node_id ?? null,
      display_name: self?.display_name ?? settings.display_name ?? null,
      port,
      endpoints,
      suggested_endpoints: usable.length > 0 ? usable : detectLocalEndpoints(port),
      permission_modes: SANDBOX_MODES,
      reasoning_efforts: this.catalog.current().reasoningEfforts,
      bind_choices: [...new Set([...PanelModel.bindChoices(port), settings.bind_host])],
      peers: [...new Set([...settings.peers, ...pod.rememberedPeers])],
      data_root: pod.dataRoot,
      password_set: await pod.passwordConfigured(),
      running: current !== null,
      error: status.kind === "failed" ? status.error.message : null,
    };
  }

  /** Listen-address choices for setup UIs: loopback, every interface, then each detected local address. */
  private static bindChoices(port: number): string[] {
    const hosts = detectLocalEndpoints(port).map((url) => new URL(url).hostname.replace(/^\[|\]$/g, ""));
    return [...new Set(["127.0.0.1", "::", ...hosts])];
  }

  /** Store a new password, write the panel fields into the settings file, and restart. */
  async saveConfig(patch: PanelPatch): Promise<PodConfigView> {
    // The password goes to the DSH credential store and the other fields to the
    // settings file; the password is machine-wide, so switching workgroups keeps it.
    await this.pod.reconfigure(patch);
    return this.config();
  }

  /** `join` one peer now and remember it for later starts. */
  async connect(peer: string): Promise<PodConfigView> {
    await this.pod.addPeer(normalizePeerUrl(peer));
    return this.config();
  }

  /** Delete this machine's node: workgroup, password, node key, settings and peers (first-run wizard again). */
  async reset(): Promise<PodConfigView> {
    await this.pod.reset();
    return this.config();
  }

  /** This node's own advertised record, or null while it is not running. */
  private self(): PodPeer<SelfRecord> | null {
    const current = this.pod.run?.orca;
    if (current === undefined) return null;
    const self = current.mesh.self.selfRecord();
    return {
      ...self,
      busy_from: self.busy === null ? null : new RosterLabels(current).label(self.busy.origin_orca_node),
    };
  }

  /** Reachable members only: offline records are dropped. */
  private members(): PodPeer[] {
    const current = this.pod.run?.orca;
    if (current === undefined) return [];
    const labels = new RosterLabels(current);
    return current.mesh
      .peers()
      .map((node) => node.view())
      .filter((member) => member.state !== "offline")
      .map((member) => ({
        ...member,
        busy_from: member.busy === null ? null : labels.label(member.busy.origin_orca_node),
      }));
  }

  /** Permission requests waiting for the human, one per task. */
  private approvals(): PodApproval[] {
    const labels = new RosterLabels(this.pod.run?.orca ?? null);
    return this.broker.list().map(({ node, task_id, request, agent_id }) => ({
      id: taskKey(node, task_id),
      peer: node,
      task_id,
      tool: request.tool,
      requested: PanelModel.preview(request.requested),
      from: labels.label(request.requested_by),
      current_mode: request.current_mode,
      requested_mode: request.requested_mode,
      agent_id,
    }));
  }

  private workspace(): WorkspaceView | null {
    const workspace = this.pod.run?.orca.workspace;
    if (workspace === undefined) return null;
    return { root: workspace.root, state: workspace.state };
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

  /**
   * The files a task's result names (§5.6). Files are not part of a task: the
   * agent writes their names into its text, and the panel offers each as a link.
   */
  private static filesOf(view: TaskView): PodFileRef[] {
    const text = view.status.message === undefined ? "" : messageText(view.status.message);
    const found = new Map<string, PodFileRef>();
    for (const [name] of text.matchAll(FILE_NAME)) {
      const ref = parseBlobRef(name);
      if (ref !== null) found.set(name, ref);
    }
    return [...found.values()];
  }

  /** A task this node dispatched: its who is the target. */
  private static dispatchRow(labels: RosterLabels, entry: DispatchEntry): PodTaskRow {
    return {
      id: entry.task_id,
      peer: entry.node,
      state: entry.state,
      who: labels.label(entry.node),
      who_title: entry.node,
      at: entry.updated_at,
      files: [],
      cancellable: PanelModel.isActive(entry.state),
    };
  }

  /** A task this node runs: its who is the node that dispatched it. */
  private static localRow(current: Orca, labels: RosterLabels, view: TaskView): PodTaskRow {
    const origin = PanelModel.podOf(view).origin_orca_node;
    return {
      id: view.id,
      peer: current.mesh.self.id,
      state: view.status.state,
      who: labels.label(origin),
      who_title: origin ?? "",
      at: view.status.timestamp,
      files: PanelModel.filesOf(view),
      cancellable: PanelModel.isActive(view.status.state),
    };
  }
}
