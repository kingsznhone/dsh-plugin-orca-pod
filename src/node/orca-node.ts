import { Readable } from "node:stream";
import { isWildcardHost } from "@deepseek-ai/dsh-host-webserver";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { cpus, platform as osPlatform, release as osRelease, totalmem } from "node:os";

import { workgroupKey, type OrcaNodeConfig } from "./config.ts";
import {
  BLOB_ID_PATTERN,
  createFileBlobRegistry,
  createMemoryFileBlobStore,
  createSqliteFileBlobStore,
} from "../core/blobs.ts";
import { createMemoryDispatchStore, createSqliteDispatchStore } from "../task/dispatch-store.ts";
import { createMemoryTaskStore, createSqliteTaskStore } from "../task/task-store.ts";
import type { FileBlobStore, OpenedBlob } from "../core/blobs.ts";
import type { DispatchStore } from "../task/dispatch-store.ts";
import type { TaskStore } from "../task/task-store.ts";
import type { DispatchEntry, SubmitTaskInput, TaskView } from "../task/wire.ts";
import { NonceCache } from "../core/signing.ts";
import { loadIdentity } from "../core/identity.ts";
import { createDelegation, type ApprovalOptions, type TaskCallOptions } from "../task/delegation.ts";
import { EchoExecutor } from "../executor/echo.ts";
import { createAcpExecutor } from "../executor/acp/executor.ts";
import type { LocalExecutor } from "../executor/executor.ts";
import { createEventBus } from "../core/events.ts";
import { errorMessage, PodError } from "../core/errors.ts";
import type { NodeLogger } from "../core/events.ts";
import { bindUrl, detectLocalEndpoints, isBlockedFetchPort, pickFreePort } from "../core/net.ts";
import { createGateway } from "../api/gateway.ts";
import { createPeerClient, type FetchLike } from "../mesh/peer-client.ts";
import { createWorkgroup, type LeaveResult } from "../mesh/workgroup.ts";
import { createMembership, type MembershipClock, type MembershipTimings } from "../mesh/membership.ts";
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
import { createTaskRunner } from "../task/runner.ts";
import { createWorkspaceManager, type WorkspacePaths } from "../task/workspace.ts";

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
    taskStore: createSqliteTaskStore(storeDbPath(config.data_root)),
    fileBlobStore: createSqliteFileBlobStore(storeDbPath(config.data_root)),
    dispatchStore: createSqliteDispatchStore(storeDbPath(config.data_root)),
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
  const taskStore = storage?.taskStore ?? createMemoryTaskStore();
  const fileBlobStore = storage?.fileBlobStore ?? createMemoryFileBlobStore();
  const fileBlobs = createFileBlobRegistry(fileBlobStore);
  const dispatches = storage?.dispatchStore ?? createMemoryDispatchStore();
  const events = createEventBus<PodEventInput>();
  const workspaceManager = createWorkspaceManager({ dataRoot: config.data_root, workgroupId: config.workgroup_id });
  const workspace = workspaceManager.ensure();
  const logger = options.logger ?? SILENT;
  /** Advertised per-task budget; also the hard cap the task runner enforces (§6.9). */
  const maxTaskTtlS = config.task_timeout_s ?? 3600;
  const executor: LocalExecutor =
    options.executor ??
    (config.executor === "acp"
      ? createAcpExecutor({
          ...config.acp,
          data_root: config.data_root,
          modelDefaults: () => group.modelDefaults(),
          logger,
        })
      : new EchoExecutor());

  let endpoints = endpointsFrom(config, config.port);
  const membership = createMembership({
    selfOrcaNodeId: config.orca_node_id,
    timings: options.timings,
    clock: options.clock,
  });
  const client = createPeerClient({
    identity,
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    // Every outbound call needs a deadline (§4.7): a peer that accepts the
    // connection and then stalls would otherwise hang a tool call or the tracker.
    timeoutMs: config.request_timeout_ms ?? 30_000,
    selfEndpoints: () => endpoints,
    roster: () => membership.list(),
  });
  const group = createWorkgroup({
    config,
    key,
    runtime: options.runtime ?? collectRuntime(),
    maxTaskTtlS,
    membership,
    client,
    logger,
    endpoints: () => endpoints,
    busy: () => tasks.busy(),
    emit: events.emit,
    adaptiveHeartbeat: options.timings?.intervalMs === undefined,
  });
  const tasks = createTaskRunner({
    executor,
    fileBlobs,
    store: taskStore,
    workspace,
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
    onEvent: (view) => {
      events.emit({ type: "task", view });
      // The busy holder is part of every member record; re-render it too.
      group.emitMembersIfChanged();
    },
  });
  const delegation = createDelegation({
    identity,
    workgroupId: config.workgroup_id,
    client,
    membership,
    dispatches,
    emit: events.emit,
  });
  const app = createGateway({
    orcaNode: {
      orca_node_id: config.orca_node_id,
      workgroup_id: config.workgroup_id,
      self: group.self,
      fetchBlob,
    },
    identity,
    workgroupKey: key,
    peers: membership.peers,
    nonceCache: new NonceCache(),
    startedAt: Date.now(),
    tasks,
    fileBlobs,
  });

  async function fetchBlob(nodeId: OrcaNodeId, blobId: string, signal?: AbortSignal): Promise<OpenedBlob> {
    if (!BLOB_ID_PATTERN.test(blobId)) throw new PodError("bad_request", "a blob id is a lowercase sha256 hex digest");
    if (nodeId === config.orca_node_id) return fileBlobs.open(blobId);
    const addresses = await group.endpointsOf(nodeId);
    if (addresses.length === 0) throw new PodError("unknown_orca_node", `${nodeId} is not a member of this workgroup`);
    let unreachable: unknown;
    for (const endpoint of addresses) {
      try {
        const { body, size } = await client.download(endpoint, `/blobs/${blobId}`, { target: nodeId, signal });
        return { stream: Readable.fromWeb(body as WebReadableStream<Uint8Array>), size };
      } catch (error) {
        // The node answered: its answer stands. Only an address that does not answer moves on to the next.
        if (error instanceof Error && error.name === "PodError") throw error;
        unreachable = error;
      }
    }
    throw new PodError("peer_not_online", `${nodeId} did not answer at any address: ${errorMessage(unreachable)}`);
  }

  /** Port 0 would let the kernel hand out a port `fetch` refuses to dial (e.g. 6000); pick one it accepts. */
  async function listen(): Promise<string> {
    const { bind_host: host, port } = config;
    if (port !== 0) {
      if (isBlockedFetchPort(port))
        throw new Error(`listen port ${port} is blocked by fetch; choose another listen port`);
      return app.listen({ host, port });
    }
    // The probed port can be taken again before we bind it; retry with a fresh one.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await app.listen({ host, port: await pickFreePort() });
      } catch (error) {
        if (attempt === 5) throw error;
      }
    }
  }

  return {
    orcaNodeId: config.orca_node_id,
    config,
    get endpoints(): string[] {
      return [...endpoints];
    },
    get heartbeatIntervalMs(): number {
      return membership.timings.intervalMs;
    },

    async start() {
      tasks.recover();
      const address = await listen();
      const port = Number(new URL(address).port);
      endpoints = endpointsFrom(config, port);
      delegation.start();
      group.start();
      return { url: endpoints[0], port };
    },
    async stop() {
      group.stop();
      await app.close();
      await executor.close?.();
      taskStore.close();
      fileBlobStore.close();
      dispatches.close();
    },
    self: group.self,
    members: group.members,
    membersDigest: group.membersDigest,
    setModelCatalog: group.setModelCatalog,
    join: group.join,
    heartbeat: group.heartbeat,
    leave: group.leave,
    sendTask: delegation.sendTask,
    getTask: delegation.getTask,
    cancelTask: delegation.cancelTask,
    approveTask: delegation.approveTask,
    denyTask: delegation.denyTask,
    listDispatches: delegation.listDispatches,
    annotateDispatch: delegation.annotateDispatch,
    listTasks: (limit = 200) => tasks.list(limit),
    subscribe: events.subscribe,
    fetchBlob,
    nodeIdOf: (endpoint) => client.idOf(endpoint),
    workspacePaths() {
      return { root: workspace.root, notes: workspace.notes, state: workspace.state };
    },
  };
}
