import { isWildcardHost } from "@deepseek-ai/dsh-host-webserver";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { cpus, platform as osPlatform, release as osRelease, totalmem } from "node:os";

import { workgroupKey, type OrcaNodeConfig } from "./config.ts";
import { DiskBlobRegistry, MemoryFileBlobStore, SqliteFileBlobStore } from "../core/blobs.ts";
import { MemoryDispatchStore, SqliteDispatchStore } from "../task/dispatch-store.ts";
import { MemoryTaskStore, SqliteTaskStore } from "../task/task-store.ts";
import type { FileBlobStore, OpenedBlob } from "../core/blobs.ts";
import type { DispatchStore } from "../task/dispatch-store.ts";
import type { TaskStore } from "../task/task-store.ts";
import type { DispatchEntry, SubmitTaskInput, TaskView } from "../task/wire.ts";
import { loadIdentity } from "../core/identity.ts";
import { Delegation, type ApprovalOptions, type TaskCallOptions } from "../task/delegation.ts";
import { EchoExecutor } from "../executor/echo.ts";
import { AcpExecutor } from "../executor/acp/executor.ts";
import type { LocalExecutor } from "../executor/executor.ts";
import { DEFAULT_TASK_TIMEOUT_S } from "../core/constants.ts";
import { EventBus } from "../core/events.ts";
import { ModelCatalog } from "../core/model-catalog.ts";
import type { NodeLogger } from "../core/events.ts";
import { bindUrl, detectLocalEndpoints } from "../core/net.ts";
import { Gateway } from "../api/gateway.ts";
import { BlobFetcher } from "../mesh/blob-fetcher.ts";
import { HttpPeerClient, type FetchLike } from "../mesh/peer-client.ts";
import { HeartbeatLoop } from "../mesh/heartbeat.ts";
import { SelfProfile } from "../mesh/self-profile.ts";
import { Workgroup, type LeaveResult } from "../mesh/workgroup.ts";
import { Membership, type MembershipClock, type MembershipTimings } from "../mesh/membership.ts";
import type {
  HeartbeatResponse,
  JoinResponse,
  PeerView,
  RuntimeInfo,
  SelfRecord,
  OrcaNodeId,
} from "../core/wire/peer.ts";
import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ModelOffer } from "../core/wire/model.ts";
import type { PodEventInput, PodEventListener } from "./events.ts";
import { storeDbPath } from "../core/sqlite.ts";
import { SingleSlotTaskRunner } from "../task/runner.ts";
import { ensureWorkspace, workspacePathsOf, type WorkspacePaths } from "../task/workspace.ts";

/** Snapshot of the local runtime, used to advertise what this machine can do. */
function collectRuntime(): RuntimeInfo {
  const platform = osPlatform();
  const processors = cpus();
  return {
    os: {
      family: platform,
      name: platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform,
      version: osRelease(),
    },
    arch: process.arch,
    cpu: {
      model: processors[0]?.model ?? "unknown",
      logical_cores: processors.length,
    },
    memory: { total_bytes: totalmem() },
    node: { version: process.version },
    captured_at: new Date().toISOString(),
  };
}

/** Durable stores; absent => in-memory (tests, harness). */
export type OrcaNodeStorage = {
  taskStore?: TaskStore;
  /** Durable file-blob mapping; the CLI writes it, the gateway reads it. */
  fileBlobStore?: FileBlobStore;
  /** Origin-side dispatch log: what this node handed to peers (§8.3). */
  dispatchStore?: DispatchStore;
};

/**
 * Persistent defaults: one SQLite database under `<data_root>` for tasks,
 * published files and dispatches (§5.5, §5.6). The CLI and the DSH plugin opt in; tests do not, so they stay
 * isolated and fast.
 */
export function createPersistentStorage(config: OrcaNodeConfig): OrcaNodeStorage {
  return {
    taskStore: new SqliteTaskStore(storeDbPath(config.data_root)),
    fileBlobStore: new SqliteFileBlobStore(storeDbPath(config.data_root)),
    dispatchStore: new SqliteDispatchStore(storeDbPath(config.data_root)),
  };
}

export type CreateNodeOptions = {
  config: OrcaNodeConfig;
  runtime?: RuntimeInfo;
  timings?: Partial<MembershipTimings>;
  clock?: MembershipClock;
  /** Outbound HTTP for peer calls; tests inject packet loss / delay / partitions. */
  fetch?: FetchLike;
  /** Durable stores; omit for an in-memory orcaNode. */
  storage?: OrcaNodeStorage;
  /** Executor override; defaults to config.executor (echo when unset). */
  executor?: LocalExecutor;
  /** Where refusals and drops are reported; silent unless the entry point supplies one. */
  logger?: NodeLogger;
};

export interface OrcaNode {
  readonly orcaNodeId: OrcaNodeId;
  readonly config: OrcaNodeConfig;
  /** Advertised dial URLs, best first (IPv4/IPv6/LAN/public); first is primary. */
  readonly endpoints: string[];
  /** Current heartbeat period; adaptive to mesh size unless pinned (§3.3). */
  readonly heartbeatIntervalMs: number;

  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  self(): SelfRecord;
  members(): PeerView[];
  membersDigest(): string;
  /**
   * Advertise the model routes an ACP session can be switched to, plus the
   * default route (§6.15). Host integrations call this after the DSH model
   * catalog is available; known peers get it with this node's next heartbeat
   * (the request carries the full self-description), new ones at join.
   */
  setModelCatalog(
    models: ModelOffer[],
    defaultModel: ModelSelection | null,
    defaultReasoningEffort?: ReasoningEffortId | null,
  ): void;
  /**
   * Admit this node at `peerUrl` with the workgroup password. This is the only
   * call that reaches a URL the node has not met: every other peer call
   * (`sendTask`, `getTask`, `heartbeat`, …) fails with `unknown_peer` for it.
   */
  join(peerUrl: string): Promise<JoinResponse>;
  heartbeat(peerUrl: string): Promise<HeartbeatResponse>;
  /** Leave the workgroup: tell every known peer, then clear the local roster. */
  leave(): Promise<LeaveResult>;
  sendTask(peerUrl: string, input: SubmitTaskInput, options?: TaskCallOptions): Promise<TaskView>;
  getTask(peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView>;
  cancelTask(peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView>;
  /** Approve a suspended permission request: sign a grant and resume the task (§7.11). */
  approveTask(peerUrl: string, view: TaskView, options?: ApprovalOptions): Promise<TaskView>;
  /** Deny a suspended permission request: the remote task fails with permission_denied. */
  denyTask(peerUrl: string, view: TaskView, reason?: string): Promise<TaskView>;
  /** Origin-side dispatch log, oldest first (§8.3). */
  listDispatches(): DispatchEntry[];
  /**
   * Remember which DSH session dispatched a task, so the host can resume
   * background tracking after a restart (§8.3). The dispatch entry must already
   * exist; unknown ids are ignored.
   */
  annotateDispatch(taskId: string, agentId: SessionId): void;
  /** Local (inbound) tasks, newest first, for the UI task panel (§9.2). */
  listTasks(limit?: number): TaskView[];
  /**
   * Subscribe to in-process state changes (task/member/dispatch). Returns an
   * unsubscribe function; a throwing listener never reaches the node.
   */
  subscribe(listener: PodEventListener): () => void;
  /**
   * A file a member published, streamed (§5.6): this node's own from disk,
   * another member's fetched from the first of its addresses that answers. A
   * file is named by who published it and its sha256, never by a URL.
   */
  fetchBlob(nodeId: OrcaNodeId, blobId: string, signal?: AbortSignal): Promise<OpenedBlob>;
  /** The member behind a URL (this node included), when it is known. */
  nodeIdOf(endpoint: string): OrcaNodeId | undefined;
  /** Workspace directories for UI browsing. */
  workspacePaths(): WorkspacePaths;
}

/**
 * Join every peer in a directory response, best-effort: one unreachable peer
 * must not stop an orca node from joining the rest of the mesh (§3.2).
 */
export async function joinRoster(
  orcaNode: OrcaNode,
  members: readonly PeerView[],
): Promise<{ joined: string[]; failed: string[] }> {
  const joined: string[] = [];
  const failed: string[] = [];
  for (const member of members) {
    if (member.orca_node_id === orcaNode.orcaNodeId || member.endpoints.length === 0) continue;
    ((await joinAny(orcaNode, member)) ? joined : failed).push(member.orca_node_id);
  }
  return { joined, failed };
}

/** Join one member at the first of its advertised URLs that answers (IPv6 unreachable, LAN vs public…). */
async function joinAny(orcaNode: OrcaNode, member: PeerView): Promise<boolean> {
  for (const endpoint of member.endpoints) {
    try {
      await orcaNode.join(endpoint);
      return true;
    } catch {
      // Try the peer's next advertised URL.
    }
  }
  return false;
}

/** Addresses a remote orca node should dial: explicit list, else derived from bind. */
function endpointsFrom(config: OrcaNodeConfig, port: number): [string, ...string[]] {
  const [first, ...rest] = config.endpoints;
  if (first !== undefined) return [first, ...rest];
  if (!isWildcardHost(config.bind_host)) {
    const url = bindUrl(config.bind_host, port);
    if (url !== undefined) return [url];
  }
  const [firstDetected, ...restDetected] = detectLocalEndpoints(port);
  return firstDetected === undefined ? [`http://127.0.0.1:${port}`] : [firstDetected, ...restDetected];
}

const SILENT: NodeLogger = { warn() {} };

/** Wires the node: stores and task runner, the workgroup, delegation and the gateway share one peer client. */
export function createOrcaNode(options: CreateNodeOptions): OrcaNode {
  const { config, storage } = options;
  const key = workgroupKey(config);
  // `createOrcaNodeConfig` made the identity; a config without one is not this node's.
  const identity = loadIdentity(config.data_root);
  if (identity === null || identity.orcaNodeId !== config.orca_node_id) {
    throw new Error("identity.json is missing or does not match config.orca_node_id");
  }
  const taskStore = storage?.taskStore ?? new MemoryTaskStore();
  const fileBlobStore = storage?.fileBlobStore ?? new MemoryFileBlobStore();
  const fileBlobs = new DiskBlobRegistry(fileBlobStore);
  const dispatches = storage?.dispatchStore ?? new MemoryDispatchStore();
  const events = new EventBus<PodEventInput>();
  const models = new ModelCatalog(config);
  const workspace = workspacePathsOf(config.data_root, config.workgroup_id);
  const logger = options.logger ?? SILENT;
  /** Advertised per-task budget; also the hard cap the task runner enforces (§6.9). */
  const maxTaskTtlS = config.task_timeout_s ?? DEFAULT_TASK_TIMEOUT_S;
  const executor: LocalExecutor =
    options.executor ??
    (config.executor === "acp"
      ? new AcpExecutor({ ...config.acp, data_root: config.data_root }, models, logger)
      : new EchoExecutor());

  const membership = new Membership(config.orca_node_id, { timings: options.timings, clock: options.clock });
  const profile = new SelfProfile(config, options.runtime ?? collectRuntime(), models);
  profile.setEndpoints(endpointsFrom(config, config.port));
  const client = new HttpPeerClient(identity, profile, membership, {
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    // Every outbound call needs a deadline (§4.7): a peer that accepts the
    // connection and then stalls would otherwise hang a tool call or the tracker.
    timeoutMs: config.request_timeout_ms ?? 30_000,
  });
  const group = new Workgroup(key, membership, client, profile, {
    logger,
    allow_public_peers: config.allow_public_peers,
    allow_loopback_peers: config.allow_loopback_peers,
  });
  const heartbeatLoop = new HeartbeatLoop(membership, group, options.timings?.intervalMs === undefined);
  group.events.subscribe((event) => events.emit(event));
  const tasks = new SingleSlotTaskRunner(executor, fileBlobs, taskStore, workspace, {
    logger,
    selfOrcaNodeId: config.orca_node_id,
    workgroupId: config.workgroup_id,
    permissionMode: config.permission_mode,
    permissionTtlS: config.approval_timeout_s,
    resultMaxBytes: config.result_max_bytes,
    maxWorkspaceBytes: config.max_workspace_bytes,
    maxWorkspaceFiles: config.max_workspace_files,
    taskTimeoutS: maxTaskTtlS,
    dataRoot: config.data_root,
  });
  const delegation = new Delegation(identity, client, membership, dispatches, config.workgroup_id);
  tasks.events.subscribe((event) => {
    events.emit(event);
    // The busy holder is part of every member record; re-render it too.
    profile.setBusy(tasks.busy());
    group.emitMembersIfChanged();
  });
  delegation.events.subscribe((event) => events.emit(event));
  const files = new BlobFetcher(fileBlobs, group, client, config.orca_node_id);
  const gateway = new Gateway(profile, membership, tasks, files, key);

  // A new catalog changes what this node announces about itself (§6.15).
  models.changes.subscribe(() => group.emitMembersIfChanged());

  return {
    orcaNodeId: config.orca_node_id,
    config,
    get endpoints(): string[] {
      return [...profile.endpoints];
    },
    get heartbeatIntervalMs(): number {
      return membership.timings.intervalMs;
    },

    async start() {
      ensureWorkspace(workspace);
      tasks.start();
      const address = await gateway.listen(config.bind_host, config.port);
      const port = Number(new URL(address).port);
      const urls = endpointsFrom(config, port);
      profile.setEndpoints(urls);
      delegation.start();
      heartbeatLoop.start();
      return { url: urls[0], port };
    },
    async stop() {
      heartbeatLoop.stop();
      await gateway.close();
      await executor.close?.();
      taskStore.close();
      fileBlobStore.close();
      dispatches.close();
    },
    self: () => group.self(),
    members: () => group.members(),
    membersDigest: () => group.digest(),
    setModelCatalog: (offers, defaultModel, defaultEffort) => models.update(offers, defaultModel, defaultEffort),
    join: (peerUrl) => group.join(peerUrl),
    heartbeat: (peerUrl) => group.heartbeat(peerUrl),
    leave: () => group.leave(),
    sendTask: (peerUrl, input, callOptions) => delegation.sendTask(peerUrl, input, callOptions),
    getTask: (peerUrl, taskId, callOptions) => delegation.getTask(peerUrl, taskId, callOptions),
    cancelTask: (peerUrl, taskId, callOptions) => delegation.cancelTask(peerUrl, taskId, callOptions),
    approveTask: (peerUrl, view, approval) => delegation.approveTask(peerUrl, view, approval),
    denyTask: (peerUrl, view, reason) => delegation.denyTask(peerUrl, view, reason),
    listDispatches: () => delegation.log.list(),
    annotateDispatch: (taskId, agentId) => delegation.log.annotate(taskId, agentId),
    listTasks: (limit = 200) => tasks.list(limit),
    subscribe: (listener) => events.subscribe(listener),
    fetchBlob: (nodeId, blobId, signal) => files.fetch(nodeId, blobId, signal),
    nodeIdOf: (endpoint) => client.idOf(endpoint),
    workspacePaths() {
      return { root: workspace.root, notes: workspace.notes, state: workspace.state };
    },
  };
}
