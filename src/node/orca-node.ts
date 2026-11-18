import { isWildcardHost } from "@deepseek-ai/dsh-host-webserver";
import { cpus, platform as osPlatform, release as osRelease, totalmem } from "node:os";

import { Gateway } from "../api/gateway.ts";
import { DiskBlobRegistry, MemoryFileBlobStore, SqliteFileBlobStore, type FileBlobStore } from "../core/blobs.ts";
import type { OpenedBlob } from "../core/blobs.ts";
import { DEFAULT_TASK_TIMEOUT_S } from "../core/constants.ts";
import { EventBus, type NodeLogger } from "../core/events.ts";
import { loadIdentity, type NodeIdentity } from "../core/identity.ts";
import { ModelCatalog } from "../core/model-catalog.ts";
import { bindUrl, detectLocalEndpoints } from "../core/net.ts";
import { storeDbPath } from "../core/sqlite.ts";
import type { OrcaNodeId, RuntimeInfo } from "../core/wire/peer.ts";
import { AcpExecutor } from "../executor/acp/executor.ts";
import { EchoExecutor } from "../executor/echo.ts";
import type { LocalExecutor } from "../executor/executor.ts";
import { BlobFetcher } from "../mesh/blob-fetcher.ts";
import { HeartbeatLoop } from "../mesh/heartbeat.ts";
import { Membership, type MembershipClock, type MembershipTimings } from "../mesh/membership.ts";
import { HttpPeerClient, type FetchLike } from "../mesh/peer-client.ts";
import { SelfProfile } from "../mesh/self-profile.ts";
import { Workgroup } from "../mesh/workgroup.ts";
import { Delegation } from "../task/delegation.ts";
import { MemoryDispatchStore, SqliteDispatchStore, type DispatchStore } from "../task/dispatch-store.ts";
import { SingleSlotTaskRunner } from "../task/runner.ts";
import { MemoryTaskStore, SqliteTaskStore, type TaskStore } from "../task/task-store.ts";
import { Workspace } from "../task/workspace.ts";
import { workgroupKey, type OrcaNodeConfig } from "./config.ts";
import type { PodEventInput } from "./events.ts";

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

export type OrcaNodeOptions = {
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

/**
 * The assembly point of an orca node: it builds the subsystems, wires them to
 * each other and publishes them as read-only fields. Callers use the
 * subsystems directly (`node.mesh.join`, `node.delegation.sendTask`,
 * `node.tasks.list`…); the node itself keeps only what spans them.
 *
 * Building a node is cheap and quiet: it reads `identity.json` and nothing
 * else touches the disk or the network until `start()`.
 */
export class OrcaNode {
  readonly identity: NodeIdentity;
  /** Everything a UI panel may re-render: task, member and dispatch changes of all subsystems (§9.2). */
  readonly events: EventBus<PodEventInput>;
  /** The model routes this node offers and the default a task gets (§6.15). */
  readonly models: ModelCatalog;
  readonly membership: Membership;
  /** What this node says about itself; `profile.endpoints` are its dial URLs once started. */
  readonly profile: SelfProfile;
  readonly client: HttpPeerClient;
  /** Join, heartbeat and leave (§3). */
  readonly mesh: Workgroup;
  /** Tasks this node runs for others. */
  readonly tasks: SingleSlotTaskRunner;
  /** Tasks this node hands to others, and the log of them. */
  readonly delegation: Delegation;
  /** Workspace directories, for UI browsing. */
  readonly workspace: Workspace;

  private readonly executor: LocalExecutor;
  private readonly taskStore: TaskStore;
  private readonly fileBlobStore: FileBlobStore;
  private readonly dispatchStore: DispatchStore;
  private readonly files: BlobFetcher;
  private readonly heartbeatLoop: HeartbeatLoop;
  private readonly gateway: Gateway;

  constructor(
    readonly config: OrcaNodeConfig,
    options: OrcaNodeOptions = {},
  ) {
    const { storage } = options;
    const logger = options.logger ?? SILENT;
    // `createOrcaNodeConfig` made the identity; a config without one is not this node's.
    const identity = loadIdentity(config.data_root);
    if (identity === null || identity.orcaNodeId !== config.orca_node_id) {
      throw new Error("identity.json is missing or does not match config.orca_node_id");
    }
    this.identity = identity;
    this.events = new EventBus(logger);
    this.taskStore = storage?.taskStore ?? new MemoryTaskStore();
    this.fileBlobStore = storage?.fileBlobStore ?? new MemoryFileBlobStore();
    this.dispatchStore = storage?.dispatchStore ?? new MemoryDispatchStore();
    const blobs = new DiskBlobRegistry(this.fileBlobStore);
    /** One scrypt derivation per start (§7.1). */
    const key = workgroupKey(config);
    this.workspace = new Workspace(config.data_root, config.workgroup_id);
    /** Advertised per-task budget; also the hard cap the task runner enforces (§6.9). */
    const maxTaskTtlS = config.task_timeout_s ?? DEFAULT_TASK_TIMEOUT_S;

    this.models = new ModelCatalog(config, logger);
    this.membership = new Membership(config.orca_node_id, { timings: options.timings, clock: options.clock });
    this.profile = new SelfProfile(config, options.runtime ?? collectRuntime(), this.models, maxTaskTtlS);
    this.profile.setEndpoints(endpointsFrom(config, config.port));
    this.client = new HttpPeerClient(identity, this.profile, this.membership, {
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      // Every outbound call needs a deadline (§4.7): a peer that accepts the
      // connection and then stalls would otherwise hang a tool call or the tracker.
      timeoutMs: config.request_timeout_ms ?? 30_000,
    });
    this.executor =
      options.executor ??
      (config.executor === "acp"
        ? new AcpExecutor(config.acp ?? {}, config.data_root, this.models, logger)
        : new EchoExecutor());
    this.tasks = new SingleSlotTaskRunner(this.executor, blobs, this.taskStore, this.workspace, {
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
    this.mesh = new Workgroup(key, this.membership, this.client, this.profile, {
      logger,
      dial: { allowPublicPeers: config.allow_public_peers, allowLoopbackPeers: config.allow_loopback_peers },
    });
    this.heartbeatLoop = new HeartbeatLoop(this.membership, this.mesh, options.timings?.intervalMs === undefined);
    this.delegation = new Delegation(identity, this.client, this.membership, this.dispatchStore, {
      workgroupId: config.workgroup_id,
      logger,
    });
    this.files = new BlobFetcher(blobs, this.mesh, this.client, config.orca_node_id);
    this.gateway = new Gateway(this.profile, this.membership, this.tasks, this.files, key);

    // The subsystems tell, the node decides who needs to know.
    this.tasks.events.subscribe((event) => {
      this.events.emit(event);
      // The busy holder is part of every member record; re-render it too.
      this.profile.setBusy(this.tasks.busy());
      this.mesh.emitMembersIfChanged();
    });
    this.mesh.events.subscribe((event) => this.events.emit(event));
    this.delegation.events.subscribe((event) => this.events.emit(event));
    // A new catalog changes what this node announces about itself (§6.15).
    this.models.changes.subscribe(() => this.mesh.emitMembersIfChanged());
  }

  get orcaNodeId(): OrcaNodeId {
    return this.config.orca_node_id;
  }

  /** Bind the listener and start the heartbeat; resolves with the URL peers should dial. */
  async start(): Promise<{ url: string; port: number }> {
    this.workspace.ensure();
    this.tasks.start();
    const address = await this.gateway.listen(this.config.bind_host, this.config.port);
    const port = Number(new URL(address).port);
    const urls = endpointsFrom(this.config, port);
    this.profile.setEndpoints(urls);
    this.delegation.start();
    this.heartbeatLoop.start();
    return { url: urls[0], port };
  }

  async stop(): Promise<void> {
    this.heartbeatLoop.stop();
    await this.gateway.close();
    await this.executor.close?.();
    this.taskStore.close();
    this.fileBlobStore.close();
    this.dispatchStore.close();
  }

  /**
   * A file a member published, streamed (§5.6): this node's own from disk,
   * another member's fetched from the first of its addresses that answers. A
   * file is named by who published it and its sha256, never by a URL.
   */
  fetchBlob(nodeId: OrcaNodeId, blobId: string, signal?: AbortSignal): Promise<OpenedBlob> {
    return this.files.fetch(nodeId, blobId, signal);
  }
}
