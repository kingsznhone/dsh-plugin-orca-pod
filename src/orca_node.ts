import { randomUUID } from "node:crypto";
import { cpus, platform as osPlatform, release as osRelease, totalmem } from "node:os";
import { join } from "node:path";

import { workgroupKey, type OrcaNodeConfig } from "./config.ts";
import { childPodMetadata, deriveChildGrant } from "./chain.ts";
import { createFileBlobRegistry, type FileBlobStore } from "./blob_files.ts";
import { buildAuthHeader, blobLinkSignature, buildHeartbeatProof, buildJoinProof, NonceCache, signGrant } from "./crypto.ts";
import {
  createMemoryDispatchStore,
  TERMINAL_TASK_STATES,
  type DispatchEntry,
  type DispatchStore,
} from "./dispatches.ts";
import { EchoExecutor, type LocalExecutor } from "./executor.ts";
import { createPodEventBus, type PodEventListener } from "./events.ts";
import {
  candidateEndpointAllowed,
  detectLocalEndpoints,
  isBlockedFetchPort,
  pickFreePort,
} from "./net.ts";
import { createAcpExecutor } from "./acp.ts";
import { createGateway } from "./gateway.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { createMembership, heartbeatIntervalMsFor, type MembershipClock, type MembershipTimings } from "./membership.ts";
import {
  membersDigest as computeMembersDigest,
  permissionRequestOf,
  PROTOCOL_VERSION,
  runtimeDigest,
  type A2AMessage,
  type Grant,
  type GrantMode,
  type HeartbeatResponse,
  type JoinResponse,
  type ModelOffer,
  type ModelSelection,
  type PeerView,
  type PodTaskMetadata,
  type RuntimeInfo,
  type SelfRecord,
  type SignedGrant,
  type SubmitTaskInput,
  type TaskRelay,
  type TaskView,
} from "./protocol.ts";
import {
  createSqliteDispatchStore,
  createSqliteFileBlobStore,
  createSqliteTaskStore,
} from "./sqlite.ts";
import {
  createFsBlobStore,
  createMemoryBlobStore,
  DEFAULT_BLOB_TTL_MS,
  type BlobStore,
  type PeerStore,
  type TaskStore,
} from "./storage.ts";
import { createTaskRunner } from "./tasks.ts";
import { createWorkspaceManager, type Workspace, type WorkspaceManager } from "./workspace.ts";

/**
 * Gateway dependency record. `endpoints` is mutable: the gateway is built before
 * `listen()` (the port may be 0) and the bound endpoints are written back once
 * the listener is up, so the gateway reads the current value when it renders self.
 */
type GatewayOrcaNodeInfo = {
  orca_node_id: string;
  display_name: string;
  workgroup_id: string;
  endpoints: string[];
  max_task_ttl_s?: number;
  /** Local-only capability: register a child task for automatic relay (§7.12). */
  linkChildTask?: (parentTaskId: string, peerUrl: string, childTaskId: string) => void;
  /** Live ambient fields owned by the node: model catalog, display name (§6.15). */
  self?: () => SelfRecord;
};

/** Snapshot of the local runtime, used to advertise what this machine can do. */
export function collectRuntime(): RuntimeInfo {
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

/** Durable stores and the group workspace; absent => in-memory (tests, harness). */
export type OrcaNodeStorage = {
  taskStore?: TaskStore;
  blobStore?: BlobStore;
  workspace?: WorkspaceManager;
  /** Durable file-blob mapping; the CLI writes it, the gateway reads it. */
  fileBlobStore?: FileBlobStore;
  /** Origin-side dispatch log: what this node handed to peers (§13.4). */
  dispatchStore?: DispatchStore;
};

/**
 * Phase 2 defaults: SQLite task store, disk blobs and the group workspace under
 * `<data_root>` (§5.5, §5.6, §6.7). The CLI and the DSH plugin opt in; tests do
 * not, so they stay isolated and fast.
 */
export function createPersistentStorage(config: OrcaNodeConfig): OrcaNodeStorage {
  return {
    taskStore: createSqliteTaskStore(join(config.data_root, "tasks.db")),
    blobStore: createFsBlobStore(join(config.data_root, "blobs"), { ttlMs: DEFAULT_BLOB_TTL_MS }),
    fileBlobStore: createSqliteFileBlobStore(join(config.data_root, "tasks.db")),
    dispatchStore: createSqliteDispatchStore(join(config.data_root, "tasks.db")),
    workspace: createWorkspaceManager({ dataRoot: config.data_root, workgroupId: config.workgroup_id }),
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
};

/** Same shape as the global `fetch`, so a test can wrap it without a library. */
export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

export interface ApprovalOptions {
  mode?: GrantMode;
  /** How long the signed grant stays valid, default 300s. */
  ttlS?: number;
  reason?: string;
  /**
   * Grant this orca node holds for the task currently asking to delegate.
   * When set, approveTask derives a child grant from it instead of signing a
   * fresh top-level grant (§7.12).
   */
  parentGrant?: SignedGrant;
}

export interface OrcaNode {
  readonly orcaNodeId: string;
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
   * catalog is available; peers see it on the next roster exchange.
   */
  setModelCatalog(
    models: ModelOffer[],
    defaultModel: ModelSelection | null,
    defaultReasoningEffort?: string | null,
  ): void;
  join(peerUrl: string): Promise<JoinResponse>;
  heartbeat(peerUrl: string): Promise<HeartbeatResponse>;
  /** Leave the workgroup: tell every known peer, then clear the local roster. */
  leave(): Promise<{ left: string[] }>;
  sendTask(
    peerUrl: string,
    input: SubmitTaskInput,
    options?: { parentTaskId?: string },
  ): Promise<TaskView>;
  getTask(peerUrl: string, taskId: string): Promise<TaskView>;
  cancelTask(peerUrl: string, taskId: string): Promise<TaskView>;
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
  /** Origin-side dispatch log, oldest first (§13.4). */
  listDispatches(): DispatchEntry[];
  /** Local (inbound) tasks, newest first, for the UI task panel (§9.2). */
  listTasks(limit?: number): TaskView[];
  /**
   * Subscribe to in-process state changes (task/member/dispatch). Returns an
   * unsubscribe function; a throwing listener never reaches the node.
   */
  subscribe(listener: PodEventListener): () => void;
  /** Short-lived download URL for one blob, or null when no endpoint is known yet. */
  blobLink(blobId: string, ttlS?: number): string | null;
  /** Workspace directories for UI browsing; null when this node is memory-only. */
  workspacePaths(): { root: string; notes: string; inputs: string; state: string } | null;
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
    let ok = false;
    for (const endpoint of member.endpoints) {
      try {
        await orcaNode.join(endpoint);
        ok = true;
        break;
      } catch {
        // Try the peer's next advertised URL (IPv6 unreachable, LAN vs public…).
      }
    }
    (ok ? joined : failed).push(member.orca_node_id);
  }
  return { joined, failed };
}

/** Addresses a remote orca node should dial: explicit list, else derived from bind. */
function endpointsFrom(config: OrcaNodeConfig, port: number): string[] {
  if (config.endpoints.length > 0) return config.endpoints;
  if (config.bind.host === "0.0.0.0" || config.bind.host === "::") {
    const detected = detectLocalEndpoints(port);
    if (detected.length > 0) return detected;
    return [`http://127.0.0.1:${port}`];
  }
  return [`http://${config.bind.host}:${port}`];
}

export function createOrcaNode(options: CreateNodeOptions): OrcaNode {
  const { config } = options;
  const orcaNodeId = config.orca_node_id;
  const key = workgroupKey(config);
  const identity = loadOrCreateIdentity(config.data_root);
  if (identity.orcaNodeId !== orcaNodeId) {
    throw new Error(
      "identity.json does not match config.orca_node_id; reset the orca node to migrate",
    );
  }
  const httpFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const membership = createMembership({
    selfOrcaNodeId: orcaNodeId,
    timings: options.timings,
    clock: options.clock,
  });
  const peers: PeerStore = membership.peers;
  /**
   * §3.3: cadence follows mesh size (one pulse per node per second) so cluster
   * traffic stays linear. An explicit `timings.intervalMs` pins it for tests.
   */
  const adaptiveHeartbeat = options.timings?.intervalMs === undefined;
  function refreshHeartbeatInterval(): void {
    if (!adaptiveHeartbeat) return;
    membership.setIntervalMs(heartbeatIntervalMsFor(membership.list().length + 1));
  }
  const nonceCache = new NonceCache();
  const runtime = options.runtime ?? collectRuntime();
  const blobs = options.storage?.blobStore ?? createMemoryBlobStore();
  const fileBlobs = createFileBlobRegistry(options.storage?.fileBlobStore);
  /** §13.4: what this node dispatched to peers, so a restart does not lose track. */
  const dispatches = options.storage?.dispatchStore ?? createMemoryDispatchStore();
  /** In-process change notifications for the UI panel (§9.2). */
  const events = createPodEventBus();
  /** Advertised per-task budget; also the hard cap the task runner enforces (§6.9). */
  const maxTaskTtlS = config.task_timeout_s ?? 3600;
  const workspaceManager = options.storage?.workspace ?? null;
  const workspace: Workspace | null = workspaceManager?.get() ?? null;
  const executor: LocalExecutor =
    options.executor ??
    (config.executor === "acp"
      ? createAcpExecutor({ ...(config.acp ?? {}), data_root: config.data_root })
      : new EchoExecutor());
  const tasks = createTaskRunner({
    executor,
    blobs,
    ...(options.storage?.taskStore ? { store: options.storage.taskStore } : {}),
    ...(workspace ? { workspace } : {}),
    selfOrcaNodeId: orcaNodeId,
    workgroupId: config.workgroup_id,
    key,
    ...(config.permission_mode ? { permissionMode: config.permission_mode } : {}),
    ...(config.approval_timeout_s !== undefined ? { permissionTtlS: config.approval_timeout_s } : {}),
    ...(config.result_max_bytes !== undefined ? { resultMaxBytes: config.result_max_bytes } : {}),
    ...(config.max_input_files !== undefined ? { maxInputFiles: config.max_input_files } : {}),
    ...(config.max_input_bytes !== undefined ? { maxInputBytes: config.max_input_bytes } : {}),
    taskTimeoutS: maxTaskTtlS,
    dataRoot: config.data_root,
    modelDefaults: () => ({ model: defaultModel, reasoningEffort: defaultReasoningEffort }),
    sendTaskMessage: async (peerUrl, _taskId, message) => {
      await postA2a<TaskView>(peerUrl, "message/send", { message });
    },
    onEvent: (view) => {
      events.emit({ type: "task", view });
      // The busy holder is part of every member record; re-render it too.
      emitMembersIfChanged();
    },
  });

  let boundPort = config.bind.port;
  let actualEndpoints = endpointsFrom(config, boundPort);

  const gatewayOrcaNode: GatewayOrcaNodeInfo = {
    orca_node_id: orcaNodeId,
    display_name: config.display_name,
    workgroup_id: config.workgroup_id,
    endpoints: actualEndpoints,
    max_task_ttl_s: maxTaskTtlS,
    linkChildTask,
    self: () => self(),
  };
  const app = createGateway({
    orcaNode: gatewayOrcaNode,
    identity,
    workgroupKey: key,
    peers,
    nonceCache,
    runtime,
    tasks,
    blobs,
    fileBlobs,
  });

  let modelCatalog: ModelOffer[] = [...(config.models ?? [])];
  // A local pin in config.json wins over whatever the DSH host reports; the
  // pin is what makes per-node defaults reproducible across UI changes (§6.15).
  const configuredDefaultModel: ModelSelection | null = config.default_model ?? null;
  const configuredReasoningEffort: string | null =
    config.default_reasoning_effort ?? config.default_model?.reasoning_effort ?? null;
  let defaultModel: ModelSelection | null = configuredDefaultModel;
  let defaultReasoningEffort: string | null = configuredReasoningEffort;

  /**
   * Publish the model routes an ACP session can be switched to (§6.15). The
   * Host computes them from the DSH catalog after the node starts; peers learn
   * the new list from the next roster exchange. Local config pins still win.
   */
  function setModelCatalog(
    models: ModelOffer[],
    nextDefault: ModelSelection | null,
    nextReasoningEffort?: string | null,
  ): void {
    const seen = new Set<string>();
    modelCatalog = [];
    for (const offer of models) {
      const key = `${offer.provider}/${offer.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      modelCatalog.push(offer);
    }
    defaultReasoningEffort =
      configuredReasoningEffort ?? nextReasoningEffort ?? nextDefault?.reasoning_effort ?? null;
    const fallback = configuredDefaultModel ?? nextDefault ?? null;
    defaultModel =
      fallback === null
        ? null
        : defaultReasoningEffort === null
          ? fallback
          : { ...fallback, reasoning_effort: defaultReasoningEffort };
    emitMembersIfChanged();
  }

  function selfPeer(): PeerView {
    return {
      orca_node_id: orcaNodeId,
      // A fresh node with no display name shows its generated id (§9.2 wizard default).
      display_name: config.display_name.length > 0 ? config.display_name : orcaNodeId,
      endpoints: actualEndpoints,
      runtime,
      runtime_digest: runtimeDigest(runtime),
      state: "online",
      busy: tasks.busy(),
      last_recv_at: new Date().toISOString(),
      max_task_ttl_s: maxTaskTtlS,
      ...(modelCatalog.length > 0 ? { models: modelCatalog } : {}),
      default_model: defaultModel,
      default_reasoning_effort: defaultReasoningEffort,
    };
  }

  function roster(): PeerView[] {
    return [...membership.list(), selfPeer()];
  }

  function self(): SelfRecord {
    return { ...selfPeer(), workgroup_id: config.workgroup_id, protocol_version: PROTOCOL_VERSION };
  }

  function members(): PeerView[] {
    return membership.list();
  }

  function currentDigest(): string {
    return computeMembersDigest(roster());
  }

  /** Roster/state/busy holder projection used only to suppress duplicate events. */
  let membersSignature = "";
  function membersSignatureOf(peers: PeerView[]): string {
    return peers
      .map(
        (peer) =>
          `${peer.orca_node_id}:${peer.state}:${peer.busy?.task_id ?? ""}:${peer.endpoints.join(",")}` +
          `:${peer.models?.length ?? 0}:${peer.default_model === undefined || peer.default_model === null ? "" : `${peer.default_model.provider}/${peer.default_model.model}`}:${peer.default_reasoning_effort ?? ""}`,
      )
      .sort()
      .join("|");
  }

  /** Emit a members event only when something a UI panel would render changed (§9.2). */
  function emitMembersIfChanged(): void {
    const current = roster();
    const signature = membersSignatureOf(current);
    if (signature === membersSignature) return;
    membersSignature = signature;
    events.emit({ type: "members", members: current, digest: computeMembersDigest(current) });
  }

  async function postSigned<T>(
    peerUrl: string,
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(path, peerUrl);
    const body = JSON.stringify(payload);
    const response = await httpFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: buildAuthHeader({ identity, method: "POST", path: url.pathname, body }),
      },
      body,
      signal,
    });
    if (!response.ok) {
      const { code } = (await response.json().catch(() => ({ code: "http_error" }))) as { code?: string };
      const error = new Error(`${path} ${response.status}: ${code ?? "http_error"}`) as Error & {
        status: number;
        code: string;
      };
      error.status = response.status;
      error.code = code ?? "http_error";
      throw error;
    }
    return (await response.json()) as T;
  }

  async function join(peerUrl: string): Promise<JoinResponse> {
    // Admission (§7.1): the password-derived proof shows this node knows the
    // workgroup secret; the Ed25519 auth header shows which node is joining.
    const ts = Date.now();
    const nonce = randomUUID();
    const proof = buildJoinProof(key, {
      workgroupId: config.workgroup_id,
      orcaNodeId,
      ts,
      nonce,
    });
    const response = await postSigned<JoinResponse>(peerUrl, "/cluster/join", {
      workgroup_id: config.workgroup_id,
      orca_node_id: orcaNodeId,
      display_name: selfPeer().display_name,
      endpoints: actualEndpoints,
      runtime,
      max_task_ttl_s: maxTaskTtlS,
      ...(modelCatalog.length > 0 ? { models: modelCatalog } : {}),
      default_model: defaultModel,
      default_reasoning_effort: defaultReasoningEffort,
      ts,
      nonce,
      proof,
    });
    peers.upsert(response.self);
    membership.observeInbound(response.self.orca_node_id);
    membership.mergeRemote(response.members);
    emitMembersIfChanged();
    return response;
  }

  function sendHeartbeat(peerUrl: string): Promise<HeartbeatResponse> {
    const ts = Date.now();
    const nonce = randomUUID();
    const proof = buildHeartbeatProof(key, {
      workgroupId: config.workgroup_id,
      orcaNodeId,
      ts,
      nonce,
    });
    return postSigned<HeartbeatResponse>(
      peerUrl,
      "/cluster/heartbeat",
      {
        workgroup_id: config.workgroup_id,
        orca_node_id: orcaNodeId,
        ts,
        nonce,
        proof,
        busy: tasks.busy(),
        digest: currentDigest(),
      },
      AbortSignal.timeout(membership.timings.heartbeatTimeoutMs),
    );
  }

  /** `observeFailure: false` lets the caller count one failure per peer, not per URL. */
  async function heartbeat(peerUrl: string, observeFailure = true): Promise<HeartbeatResponse> {
    const peer = membership.findByEndpoint(peerUrl);
    try {
      let response: HeartbeatResponse;
      try {
        response = await sendHeartbeat(peerUrl);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        // 对端已把本 orca node 的记录修剪掉：join 一次让它重新认识我，并带回它的目录。
        await join(peerUrl);
        response = await sendHeartbeat(peerUrl);
      }
      membership.observeInbound(response.from);
      membership.observeOutboundOk(response.from);
      if (response.members) membership.mergeRemote(response.members);
      emitMembersIfChanged();
      return response;
    } catch (error) {
      if (isAdmissionRejection(error)) {
        // This peer still uses another password: stop answering it and forget the
        // record (§7.1). Its own heartbeats to us fail identically, so the whole
        // old mesh drops the changed node instead of keeping it "online" forever.
        if (peer) dropPeer(peer.orca_node_id, "workgroup admission rejected");
        throw error;
      }
      if (observeFailure && peer) membership.observeOutboundFail(peer.orca_node_id);
      throw error;
    }
  }

  /**
   * Leave the workgroup (§9.2 disconnect): each known peer is told so it can drop
   * this record immediately, then the local roster is cleared. Best effort — a peer
   * that is already gone must not keep us from leaving.
   */
  async function leave(): Promise<{ left: string[] }> {
    const left: string[] = [];
    for (const peer of membership.list()) {
      const [endpoint] = peer.endpoints;
      if (endpoint !== undefined) {
        try {
          await postSigned(endpoint, "/cluster/leave", { orca_node_id: orcaNodeId });
          left.push(peer.orca_node_id);
        } catch {
          // Best effort: peers that are unreachable are cleared locally below.
        }
      }
      membership.remove(peer.orca_node_id);
      preferredEndpoints.delete(peer.orca_node_id);
    }
    emitMembersIfChanged();
    return { left };
  }

  /** Signed JSON-RPC call to a peer's /a2a endpoint (§4.7). */  async function postA2a<T>(peerUrl: string, method: string, params: unknown): Promise<T> {
    const url = new URL("/a2a", peerUrl);
    const body = JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params });
    const response = await httpFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: buildAuthHeader({ identity, method: "POST", path: url.pathname, body }),
      },
      body,
    });
    const payload = (await response.json()) as {
      result?: T;
      error?: { message?: string; data?: { message?: string } };
    };
    if (!response.ok || payload.error) {
      const code = payload.error?.message ?? `http_${response.status}`;
      const error = new Error(`${method} ${response.status}: ${code}`) as Error & { code: string; status: number };
      error.code = code;
      error.status = response.status;
      throw error;
    }
    return payload.result as T;
  }

  /** Record or refresh one dispatch entry from the latest task view (§13.4). */
  function rememberDispatch(peerUrl: string, view: TaskView): void {
    const now = new Date().toISOString();
    const previous = dispatches.get(view.id);
    const entry: DispatchEntry = {
      task_id: view.id,
      peer: peerUrl,
      ...(view.contextId !== undefined ? { context_id: view.contextId } : {}),
      state: view.status.state,
      ...(view.status.reason !== undefined ? { last_error: view.status.reason } : {}),
      ...(previous?.parent_local_task_id !== undefined
        ? { parent_local_task_id: previous.parent_local_task_id }
        : {}),
      created_at: previous?.created_at ?? now,
      updated_at: now,
    };
    dispatches.save(entry);
    events.emit({ type: "dispatch", entry });
  }

  async function tracked<T extends TaskView>(peerUrl: string, call: Promise<T>): Promise<T> {
    const view = await call;
    rememberDispatch(peerUrl, view);
    return view;
  }

  async function sendTask(
    peerUrl: string,
    input: SubmitTaskInput,
    options: { parentTaskId?: string } = {},
  ): Promise<TaskView> {
    const peer = membership.findByEndpoint(peerUrl);
    if (peer && peer.state !== "online") {
      const error = new Error(`peer ${peer.orca_node_id} is ${peer.state}`) as Error & { code: string };
      error.code = "peer_not_online";
      throw error;
    }
    let body = input;
    if (options.parentTaskId !== undefined) {
      // Delegation metadata: a task an agent creates while running another task
      // inherits the parent's chain (§5.1). The receiving gateway validates it and
      // rejects callbacks to ancestors; the origin-signed grant is matched against
      // the same chain when a permission request is escalated (§7.12).
      const parent = tasks.get(options.parentTaskId);
      if (parent === null) {
        throw new Error(`unknown local task ${options.parentTaskId}`);
      }
      const parentPod = parent.metadata?.["pod"] as PodTaskMetadata | undefined;
      const callerPod = (input.metadata?.["pod"] as Record<string, unknown> | undefined) ?? {};
      const inherited = childPodMetadata(parentPod, options.parentTaskId, orcaNodeId);
      const merged: Record<string, unknown> = { ...callerPod, ...inherited };
      if (callerPod["inputs"] !== undefined) merged["inputs"] = callerPod["inputs"];
      if (callerPod["task_ttl_s"] !== undefined) merged["task_ttl_s"] = callerPod["task_ttl_s"];
      body = {
        ...input,
        metadata: {
          ...(input.metadata ?? {}),
          pod: merged as unknown as PodTaskMetadata,
        },
      };
    }
    return tracked(peerUrl, postA2a<TaskView>(peerUrl, "message/send", body));
  }

  function getTask(peerUrl: string, taskId: string): Promise<TaskView> {
    return tracked(peerUrl, postA2a<TaskView>(peerUrl, "tasks/get", { id: taskId }));
  }

  function cancelTask(peerUrl: string, taskId: string): Promise<TaskView> {
    return tracked(peerUrl, postA2a<TaskView>(peerUrl, "tasks/cancel", { id: taskId }));
  }

  /** Grant validity is deliberately short: it only has to cover one resume. */
  const GRANT_TTL_S = 300;

  function resumeMessage(view: TaskView, data: Record<string, unknown>): A2AMessage {
    return { role: "user", parts: [{ kind: "data", data }], taskId: view.id, messageId: randomUUID() };
  }

  function approveTask(peerUrl: string, view: TaskView, options: ApprovalOptions = {}): Promise<TaskView> {
    const request = permissionRequestOf(view);
    if (request === null) throw new Error("task is not waiting for a permission decision");
    let signed;
    if (options.parentGrant !== undefined) {
      // Chained approval: derive a child grant from the grant this orca node
      // holds for the task that is delegating (§7.12).
      signed = deriveChildGrant({
        parent: options.parentGrant,
        request,
        selfOrcaNodeId: orcaNodeId,
      });
    } else {
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + (options.ttlS ?? GRANT_TTL_S) * 1000);
      const grant: Grant = {
        grant_id: randomUUID(),
        workgroup_id: config.workgroup_id,
        origin_orca_node: orcaNodeId,
        task_id: view.id,
        target_orca_node: request.requested_by,
        tool: request.tool,
        mode: options.mode ?? "allow_once",
        chain: request.via,
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      };
      signed = signGrant(identity, grant);
    }
    const message = resumeMessage(view, { grant: signed });
    return tracked(peerUrl, postA2a<TaskView>(peerUrl, "message/send", { message }));
  }

  function denyTask(peerUrl: string, view: TaskView, reason = "denied by origin"): Promise<TaskView> {
    const message = resumeMessage(view, { permission_denied: true, reason });
    return tracked(peerUrl, postA2a<TaskView>(peerUrl, "message/send", { message }));
  }

  function escalateTask(peerUrl: string, taskId: string, relay: TaskRelay): Promise<TaskView> {
    return postA2a<TaskView>(peerUrl, "tasks/escalate", { taskId, relay });
  }

  type ChildLink = { parent_task_id: string; peer: string; child_task_id: string; failures: number };

  /** Tasks this node's local task delegated to, watched for child permission requests (§7.12). */
  const childLinks = new Map<string, ChildLink>();
  const CHILD_LINK_INTERVAL_MS = 1000;
  const CHILD_LINK_MAX_FAILURES = 10;
  let childLinkTimer: NodeJS.Timeout | null = null;
  let childLinkStopped = true;

  function scheduleChildLinkTick(delayMs = CHILD_LINK_INTERVAL_MS): void {
    if (childLinkStopped || childLinkTimer !== null) return;
    childLinkTimer = setTimeout(() => {
      childLinkTimer = null;
      void childLinkTick();
    }, delayMs);
    childLinkTimer.unref?.();
  }

  /**
   * Automatic chain ascent: poll a child task this node dispatched; when it asks for
   * a permission, park the local task that delegated to it (one `tasks.escalate`),
   * so the origin approves once and the grant flows back down (§7.12). The executor
   * never has to call `escalate` itself.
   */
  async function childLinkTick(): Promise<void> {
    if (childLinkStopped) return;
    for (const link of [...childLinks.values()]) {
      const parent = tasks.get(link.parent_task_id);
      if (parent === null || TERMINAL_TASK_STATES.has(parent.status.state)) {
        childLinks.delete(link.child_task_id);
        continue;
      }
      // Already parked on a permission request: wait for the origin's decision.
      if (parent.status.state !== "working") continue;
      let child: TaskView;
      try {
        child = await getTask(link.peer, link.child_task_id);
      } catch {
        link.failures += 1;
        if (link.failures >= CHILD_LINK_MAX_FAILURES) childLinks.delete(link.child_task_id);
        continue;
      }
      link.failures = 0;
      if (TERMINAL_TASK_STATES.has(child.status.state)) {
        childLinks.delete(link.child_task_id);
        continue;
      }
      const request = permissionRequestOf(child);
      if (request === null) continue;
      try {
        tasks.escalate(link.parent_task_id, { peer: link.peer, task_id: link.child_task_id, request });
      } catch (error) {
        // The parent moved on between the read and the call; stop watching.
        if ((error as { code?: string }).code === "task_not_found") childLinks.delete(link.child_task_id);
      }
    }
    if (childLinks.size > 0) scheduleChildLinkTick();
  }

  function linkChildTask(parentTaskId: string, peerUrl: string, childTaskId: string): void {
    if (parentTaskId.length === 0 || peerUrl.length === 0 || childTaskId.length === 0) {
      throw new Error("child link needs parent task, peer and child task");
    }
    const parent = tasks.get(parentTaskId);
    if (parent === null) throw new Error(`unknown local task ${parentTaskId}`);
    if (TERMINAL_TASK_STATES.has(parent.status.state)) {
      throw new Error(`local task ${parentTaskId} is already ${parent.status.state}`);
    }
    childLinks.set(childTaskId, {
      parent_task_id: parentTaskId,
      peer: peerUrl,
      child_task_id: childTaskId,
      failures: 0,
    });
    const entry = dispatches.get(childTaskId);
    if (entry !== undefined && entry.parent_local_task_id !== parentTaskId) {
      dispatches.save({ ...entry, parent_local_task_id: parentTaskId, updated_at: new Date().toISOString() });
    }
    scheduleChildLinkTick(0);
  }

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatStopped = false;

  /** Local tasks for the UI task panel (§9.2). */
  function listTasks(limit = 200): TaskView[] {
    return tasks.list(limit);
  }

  /** Subscribe to in-process state changes; the returned function unsubscribes. */
  function subscribe(listener: PodEventListener): () => void {
    return events.subscribe(listener);
  }

  /** Same URL shape the gateway's `/blobs/:id/link` mints (§5.6). */
  function blobLink(blobId: string, ttlS = 300): string | null {
    const primary = actualEndpoints[0];
    if (primary === undefined) return null;
    const exp = String(Math.floor(Date.now() / 1000) + ttlS);
    const sig = blobLinkSignature(identity, blobId, exp);
    return `${primary}/blobs/${blobId}?exp=${exp}&sig=${sig}`;
  }

  /** Workspace directories for UI browsing; null when this node is memory-only. */
  function workspacePaths(): { root: string; notes: string; inputs: string; state: string } | null {
    if (workspace === null) return null;
    return { root: workspace.root, notes: workspace.notes, inputs: workspace.inputs, state: workspace.state };
  }

  function scheduleHeartbeat(): void {
    if (heartbeatStopped) return;
    const { intervalMs } = membership.timings;
    // ±10% jitter: senders must not stay phase-locked, and the receiver's
    // suspect window (1.25 ticks) leaves room for this spread.
    const delay = intervalMs * (0.9 + Math.random() * 0.2);
    heartbeatTimer = setTimeout(() => void heartbeatTick(), delay);
    heartbeatTimer.unref();
  }

  /** Candidate endpoints came from someone else's list, so screen them before dialing (§7.7). */
  const candidatePolicy = {
    ...(config.allow_public_peers === true ? { allowPublicPeers: true } : {}),
    ...(config.allow_loopback_peers === false ? { allowLoopbackPeers: false } : {}),
  };
  const candidateVerdicts = new Map<string, boolean>();
  const warnedCandidates = new Set<string>();
  /** Last endpoint that worked per peer, tried first on the next round. */
  const preferredEndpoints = new Map<string, string>();

  /** A 401-shaped failure proves the peer no longer shares this password (§7.1). */
  function isAdmissionRejection(error: unknown): boolean {
    const failure = error as { status?: number; code?: string };
    return failure.status === 401
      || failure.code === "bad_proof"
      || failure.code === "clock_skew"
      || failure.code === "nonce_replay";
  }

  /** Drop a node that failed admission: it is not part of this mesh anymore. */
  function dropPeer(orcaNodeIdToDrop: string, reason: string): void {
    const known = membership.list().some((peer) => peer.orca_node_id === orcaNodeIdToDrop);
    if (known) console.warn(`orca-pod: dropping node ${orcaNodeIdToDrop} (${reason}, §7.1)`);
    membership.remove(orcaNodeIdToDrop);
    peers.remove(orcaNodeIdToDrop);
    preferredEndpoints.delete(orcaNodeIdToDrop);
    emitMembersIfChanged();
  }

  /** DNS lookups are not free, so each endpoint is judged once per process. */
  async function endpointAllowed(peer: PeerView, endpoint: string): Promise<boolean> {
    const cached = candidateVerdicts.get(endpoint);
    if (cached !== undefined) return cached;
    const allowed = await candidateEndpointAllowed(endpoint, candidatePolicy);
    candidateVerdicts.set(endpoint, allowed);
    if (!allowed && !warnedCandidates.has(peer.orca_node_id)) {
      warnedCandidates.add(peer.orca_node_id);
      console.warn(`orca-pod: refusing candidate endpoint ${endpoint} from ${peer.orca_node_id} (§7.7)`);
    }
    return allowed;
  }

  /** Dialable URLs for one peer: screened if it came from a remote list, last good first. */
  async function dialEndpoints(peer: PeerView): Promise<string[]> {
    const candidate = membership.originOf(peer.orca_node_id) === "candidate";
    const allowed: string[] = [];
    for (const endpoint of peer.endpoints) {
      if (!candidate || (await endpointAllowed(peer, endpoint))) allowed.push(endpoint);
    }
    const preferred = preferredEndpoints.get(peer.orca_node_id);
    if (preferred === undefined || !allowed.includes(preferred)) return allowed;
    return [preferred, ...allowed.filter((endpoint) => endpoint !== preferred)];
  }

  /**
   * Heartbeat one peer by trying its advertised URLs in order (IPv4/IPv6, LAN,
   * public): a single unreachable URL must not mark the peer offline (§7.7).
   */
  async function heartbeatPeer(peer: PeerView): Promise<void> {
    const endpoints = await dialEndpoints(peer);
    for (const endpoint of endpoints) {
      try {
        await heartbeat(endpoint, false);
        preferredEndpoints.set(peer.orca_node_id, endpoint);
        return;
      } catch (error) {
        // Every URL belongs to the same node, so a credential mismatch is final.
        if (isAdmissionRejection(error)) return;
      }
    }
    membership.observeOutboundFail(peer.orca_node_id);
  }

  async function heartbeatTick(): Promise<void> {
    if (heartbeatStopped) return;
    refreshHeartbeatInterval();
    membership.evaluate();
    const now = membership.now();
    const targets = membership
      .list()
      .filter((peer) => peer.endpoints.length > 0 && membership.needsProbe(peer.orca_node_id, now));
    await Promise.allSettled(targets.map((peer) => heartbeatPeer(peer)));
    emitMembersIfChanged();
    scheduleHeartbeat();
  }

  async function start(): Promise<{ url: string; port: number }> {
    workspaceManager?.ensure();
    workspaceManager?.purgeInputs();
    blobs.gc?.();
    tasks.recover();
    // A restart means this node no longer knows what its in-flight tasks did (§13.3).
    dispatches.markUnknown();
    childLinkStopped = false;
    // Port 0 would let the kernel hand out a port `fetch` refuses to dial (e.g.
    // 6000); peers would then report this orca node as unreachable.
    if (config.bind.port !== 0 && isBlockedFetchPort(config.bind.port)) {
      throw new Error(
        `listen port ${config.bind.port} is blocked by fetch; choose another listen port`,
      );
    }
    let address = "";
    if (config.bind.port === 0) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          address = await app.listen({ host: config.bind.host, port: await pickFreePort() });
          break;
        } catch (error) {
          if (attempt === 4) throw error;
        }
      }
    } else {
      address = await app.listen({ host: config.bind.host, port: config.bind.port });
    }
    boundPort = Number(new URL(address).port);
    actualEndpoints = endpointsFrom(config, boundPort);
    gatewayOrcaNode.endpoints = actualEndpoints;
    heartbeatStopped = false;
    void heartbeatTick();
    emitMembersIfChanged();
    return { url: actualEndpoints[0] ?? address, port: boundPort };
  }

  async function stop(): Promise<void> {
    heartbeatStopped = true;
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    childLinkStopped = true;
    if (childLinkTimer) {
      clearTimeout(childLinkTimer);
      childLinkTimer = null;
    }
    childLinks.clear();
    await app.close();
    executor.close?.();
    options.storage?.taskStore?.close?.();
    options.storage?.fileBlobStore?.close?.();
    options.storage?.dispatchStore?.close?.();
  }

  return {
    get orcaNodeId(): string {
      return orcaNodeId;
    },
    get config(): OrcaNodeConfig {
      return config;
    },
    get endpoints(): string[] {
      return [...actualEndpoints];
    },
    get heartbeatIntervalMs(): number {
      return membership.timings.intervalMs;
    },

    start,
    stop,
    self,
    members,
    membersDigest: currentDigest,
    setModelCatalog,
    join,
    heartbeat,
    leave,
    sendTask,
    getTask,
    cancelTask,
    approveTask,
    denyTask,
    escalateTask,
    linkChildTask,
    listDispatches: () => dispatches.list(),
    listTasks,
    subscribe,
    blobLink,
    workspacePaths,
  };
}
