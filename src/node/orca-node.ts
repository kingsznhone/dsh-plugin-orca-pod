import { cpus, platform as osPlatform, release as osRelease, totalmem } from "node:os";
import { join } from "node:path";

import { workgroupKey, type OrcaNodeConfig } from "./config.ts";
import { createFileBlobRegistry } from "../storage/file-registry.ts";
import {
  createMemoryFileBlobStore,
  createMemoryDispatchStore,
  createMemoryBlobStore,
  createMemoryTaskStore,
} from "../storage/memory.ts";
import {
  type FileBlobStore,
  type DispatchEntry,
  type DispatchStore,
  DEFAULT_BLOB_TTL_MS,
  type BlobStore,
  type TaskStore,
} from "../storage/stores.ts";
import { NonceCache, signedBlobUrl } from "../security/crypto.ts";
import { loadOrCreateIdentity } from "../security/identity.ts";
import {
  createDelegation,
  type ApprovalOptions,
  type SendTaskOptions,
  type TaskCallOptions,
} from "../tasks/delegation.ts";
import { EchoExecutor } from "../execution/echo.ts";
import { createAcpExecutor } from "../execution/acp/executor.ts";
import type { LocalExecutor } from "../execution/executor.ts";
import { createEventBus } from "../kernel/events.ts";
import { errorMessage } from "../kernel/errors.ts";
import type { NodeLogger } from "../kernel/events.ts";
import { detectLocalEndpoints, isBlockedFetchPort, pickFreePort } from "../transport/net.ts";
import { createGateway } from "../transport/gateway/gateway.ts";
import { createPeerClient, type FetchLike } from "../transport/peer-client.ts";
import { createWorkgroup, type LeaveResult } from "../membership/mesh.ts";
import { createMembership, type MembershipClock, type MembershipTimings } from "../membership/membership.ts";
import type {
  HeartbeatResponse,
  JoinResponse,
  PeerView,
  RuntimeInfo,
  SelfRecord,
  OrcaNodeId,
} from "../protocol/peer.ts";
import type { ModelOffer, ModelSelection, ReasoningEffort } from "../protocol/model.ts";
import type { PodEventInput, PodEventListener } from "../protocol/events.ts";
import type { SubmitTaskInput, TaskView } from "../protocol/task.ts";
import type { TaskRelay } from "../protocol/grant.ts";
import { createSqliteDispatchStore, createSqliteFileBlobStore, createSqliteTaskStore } from "../storage/sqlite.ts";
import { createFsBlobStore } from "../storage/fs.ts";
import { createTaskRunner } from "../tasks/runner.ts";
import { createWorkspaceManager, type WorkspacePaths } from "../tasks/workspace.ts";

export type { ApprovalOptions, TaskCallOptions } from "../tasks/delegation.ts";
export type { NodeLogger } from "../kernel/events.ts";
export type { FetchLike } from "../transport/peer-client.ts";

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
  blobStore?: BlobStore;
  /** Durable file-blob mapping; the CLI writes it, the gateway reads it. */
  fileBlobStore?: FileBlobStore;
  /** Origin-side dispatch log: what this node handed to peers (§8.3). */
  dispatchStore?: DispatchStore;
};

/**
 * Persistent defaults: SQLite task store and disk blobs under `<data_root>`
 * (§5.5, §5.6). The CLI and the DSH plugin opt in; tests do not, so they stay
 * isolated and fast.
 */
export function createPersistentStorage(config: OrcaNodeConfig): OrcaNodeStorage {
  return {
    taskStore: createSqliteTaskStore(join(config.data_root, "tasks.db")),
    blobStore: createFsBlobStore(join(config.data_root, "blobs"), {
      ttlMs: DEFAULT_BLOB_TTL_MS,
      maxBytes: config.max_blob_store_bytes,
    }),
    fileBlobStore: createSqliteFileBlobStore(join(config.data_root, "tasks.db")),
    dispatchStore: createSqliteDispatchStore(join(config.data_root, "tasks.db")),
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
    defaultReasoningEffort?: ReasoningEffort | null,
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
  sendTask(peerUrl: string, input: SubmitTaskInput, options?: SendTaskOptions): Promise<TaskView>;
  getTask(peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView>;
  cancelTask(peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView>;
  /** Approve a suspended permission request: sign a grant and resume the task (§7.11). */
  approveTask(peerUrl: string, view: TaskView, options?: ApprovalOptions): Promise<TaskView>;
  /** Deny a suspended permission request: the remote task fails with permission_denied. */
  denyTask(peerUrl: string, view: TaskView, reason?: string): Promise<TaskView>;
  /**
   * Park this orca node's running task because a child it delegated to needs a
   * permission only this task's origin can grant (§7.12). The CLI calls this
   * on the local node.
   */
  escalateTask(peerUrl: string, taskId: string, relay: TaskRelay): Promise<TaskView>;
  /**
   * Register a task this node's local task delegated to. While the local task runs,
   * the node polls the child and, when it asks for a permission, parks the local
   * task automatically — no explicit `escalate` call from the executor (§7.12).
   */
  linkChildTask(parentTaskId: string, peerUrl: string, childTaskId: string): void;
  /** Origin-side dispatch log, oldest first (§8.3). */
  listDispatches(): DispatchEntry[];
  /**
   * Remember which DSH session dispatched a task, so the host can resume
   * background tracking after a restart (§8.3). The dispatch entry must already
   * exist; unknown ids are ignored.
   */
  annotateDispatch(taskId: string, agentId: string): void;
  /** Local (inbound) tasks, newest first, for the UI task panel (§9.2). */
  listTasks(limit?: number): TaskView[];
  /**
   * Subscribe to in-process state changes (task/member/dispatch). Returns an
   * unsubscribe function; a throwing listener never reaches the node.
   */
  subscribe(listener: PodEventListener): () => void;
  /** Short-lived download URL for one blob. */
  blobLink(blobId: string, ttlS?: number): string;
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
  if (config.bind_host !== "0.0.0.0" && config.bind_host !== "::") return [`http://${config.bind_host}:${port}`];
  const [firstDetected, ...restDetected] = detectLocalEndpoints(port);
  return firstDetected === undefined ? [`http://127.0.0.1:${port}`] : [firstDetected, ...restDetected];
}

const SILENT: NodeLogger = { warn() {} };

/** How often expired blobs and the temp files of crashed uploads are swept (§5.6). */
export const BLOB_GC_INTERVAL_MS = 10 * 60 * 1000;

/** Wires the node: stores and task runner, the workgroup, delegation and the gateway share one peer client. */
export function createOrcaNode(options: CreateNodeOptions): OrcaNode {
  const { config, storage } = options;
  const key = workgroupKey(config);
  const identity = loadOrCreateIdentity(config.data_root);
  if (identity.orcaNodeId !== config.orca_node_id) {
    throw new Error("identity.json does not match config.orca_node_id");
  }
  const blobs = storage?.blobStore ?? createMemoryBlobStore();
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
    blobs,
    store: taskStore,
    workspace,
    logger,
    selfOrcaNodeId: config.orca_node_id,
    workgroupId: config.workgroup_id,
    permissionMode: config.permission_mode,
    permissionTtlS: config.approval_timeout_s,
    resultMaxBytes: config.result_max_bytes,
    maxInputFiles: config.max_input_files,
    maxInputBytes: config.max_input_bytes,
    maxWorkspaceBytes: config.max_workspace_bytes,
    maxWorkspaceFiles: config.max_workspace_files,
    taskTimeoutS: maxTaskTtlS,
    dataRoot: config.data_root,
    sendTaskMessage: async (peerUrl, message) => {
      await client.rpc(peerUrl, "message/send", { message });
    },
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
    tasks,
    dispatches,
    emit: events.emit,
  });
  const app = createGateway({
    orcaNode: {
      orca_node_id: config.orca_node_id,
      workgroup_id: config.workgroup_id,
      self: group.self,
      linkChildTask: delegation.linkChildTask,
    },
    identity,
    workgroupKey: key,
    peers: membership.peers,
    nonceCache: new NonceCache(),
    startedAt: Date.now(),
    tasks,
    blobs,
    fileBlobs,
  });

  let gcTimer: NodeJS.Timeout | null = null;

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
      workspaceManager.purgeInputs();
      blobs.gc();
      gcTimer = setInterval(() => {
        try {
          blobs.gc();
        } catch (error) {
          // A file another process holds (Windows) must not end the node; the next sweep retries.
          logger.warn(`blob sweep failed: ${errorMessage(error)}`);
        }
      }, BLOB_GC_INTERVAL_MS);
      gcTimer.unref();
      tasks.recover();
      const address = await listen();
      const port = Number(new URL(address).port);
      endpoints = endpointsFrom(config, port);
      delegation.start();
      group.start();
      return { url: endpoints[0], port };
    },
    async stop() {
      if (gcTimer !== null) clearInterval(gcTimer);
      gcTimer = null;
      group.stop();
      delegation.stop();
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
    escalateTask: delegation.escalateTask,
    linkChildTask: delegation.linkChildTask,
    listDispatches: delegation.listDispatches,
    annotateDispatch: delegation.annotateDispatch,
    listTasks: (limit = 200) => tasks.list(limit),
    subscribe: events.subscribe,
    blobLink(blobId, ttlS = 300) {
      // Same URL shape the gateway's `/blobs/:id/link` mints (§5.6).
      return signedBlobUrl(identity, endpoints[0], blobId, String(Math.floor(Date.now() / 1000) + ttlS));
    },
    workspacePaths() {
      return { root: workspace.root, notes: workspace.notes, inputs: workspace.inputs, state: workspace.state };
    },
  };
}
