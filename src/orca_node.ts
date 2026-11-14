import { randomUUID } from "node:crypto";
import { cpus, platform as osPlatform, release as osRelease, totalmem } from "node:os";
import { join } from "node:path";

import { workgroupKey, type OrcaNodeConfig } from "./config.ts";
import { deriveChildGrant } from "./chain.ts";
import { createFileBlobRegistry, type FileBlobStore } from "./blob-files.ts";
import { buildAuthHeader, NonceCache, signGrant } from "./crypto.ts";
import {
  createMemoryDispatchStore,
  TERMINAL_TASK_STATES,
  type DispatchEntry,
  type DispatchStore,
} from "./dispatches.ts";
import { EchoExecutor, type LocalExecutor } from "./executor.ts";
import { createHeadlessExecutor } from "./headless.ts";
import { candidateEndpointAllowed } from "./net.ts";
import { createAcpExecutor } from "./acp.ts";
import { createGateway } from "./gateway.ts";
import { createMembership, type MembershipClock, type MembershipTimings } from "./membership.ts";
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
  type PeerView,
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
 * Gateway dependency record. `endpoint` is mutable: the gateway is built before
 * `listen()` (the port may be 0) and the bound endpoint is written back once the
 * listener is up, so the gateway reads the current value when it renders self.
 */
type GatewayOrcaNodeInfo = {
  orca_node_id: string;
  display_name: string;
  workgroup_id: string;
  endpoint: string | null;
  max_task_ttl_s?: number;
  /** Local-only capability: register a child task for automatic relay (§7.12). */
  linkChildTask?: (parentTaskId: string, peerUrl: string, childTaskId: string) => void;
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
  readonly endpoint: string;
  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  self(): SelfRecord;
  members(): PeerView[];
  membersDigest(): string;
  join(peerUrl: string): Promise<JoinResponse>;
  heartbeat(peerUrl: string): Promise<HeartbeatResponse>;
  sendTask(peerUrl: string, input: SubmitTaskInput): Promise<TaskView>;
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
    if (member.orca_node_id === orcaNode.orcaNodeId || !member.endpoint) continue;
    try {
      await orcaNode.join(member.endpoint);
      joined.push(member.orca_node_id);
    } catch {
      failed.push(member.orca_node_id);
    }
  }
  return { joined, failed };
}

/** Address a remote orca node should dial: wildcard binds are reachable on loopback. */
function endpointFrom(config: OrcaNodeConfig, port: number): string {
  if (config.endpoint) return config.endpoint;
  const host = config.bind.host === "0.0.0.0" || config.bind.host === "::" ? "127.0.0.1" : config.bind.host;
  return `http://${host}:${port}`;
}

export function createOrcaNode(options: CreateNodeOptions): OrcaNode {
  const { config } = options;
  const orcaNodeId = config.orca_node_id;
  const key = workgroupKey(config);
  const httpFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const membership = createMembership({
    selfOrcaNodeId: orcaNodeId,
    timings: options.timings,
    clock: options.clock,
  });
  const peers: PeerStore = membership.peers;
  const nonceCache = new NonceCache();
  const runtime = options.runtime ?? collectRuntime();
  const blobs = options.storage?.blobStore ?? createMemoryBlobStore();
  const fileBlobs = createFileBlobRegistry(options.storage?.fileBlobStore);
  /** §13.4: what this node dispatched to peers, so a restart does not lose track. */
  const dispatches = options.storage?.dispatchStore ?? createMemoryDispatchStore();
  /** Advertised per-task budget; also the hard cap the task runner enforces (§6.9). */
  const maxTaskTtlS = config.task_timeout_s ?? 3600;
  const workspaceManager = options.storage?.workspace ?? null;
  const workspace: Workspace | null = workspaceManager?.get() ?? null;
  const executor: LocalExecutor =
    options.executor ??
    (config.executor === "headless"
      ? createHeadlessExecutor(config.headless ?? {})
      : config.executor === "acp"
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
    sendTaskMessage: async (peerUrl, _taskId, message) => {
      await postA2a<TaskView>(peerUrl, "message/send", { message });
    },
  });

  let boundPort = config.bind.port;
  let actualEndpoint = endpointFrom(config, boundPort);

  const gatewayOrcaNode: GatewayOrcaNodeInfo = {
    orca_node_id: orcaNodeId,
    display_name: config.display_name,
    workgroup_id: config.workgroup_id,
    endpoint: actualEndpoint,
    max_task_ttl_s: maxTaskTtlS,
    linkChildTask,
  };
  const app = createGateway({
    orcaNode: gatewayOrcaNode,
    key,
    peers,
    nonceCache,
    runtime,
    tasks,
    blobs,
    fileBlobs,
  });

  function selfPeer(): PeerView {
    return {
      orca_node_id: orcaNodeId,
      display_name: config.display_name,
      endpoint: actualEndpoint,
      runtime,
      runtime_digest: runtimeDigest(runtime),
      state: "online",
      busy: tasks.busy(),
      last_recv_at: new Date().toISOString(),
      max_task_ttl_s: maxTaskTtlS,
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
        authorization: buildAuthHeader({ key, orcaNodeId, method: "POST", path: url.pathname, body }),
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
    const response = await postSigned<JoinResponse>(peerUrl, "/cluster/join", {
      workgroup_id: config.workgroup_id,
      orca_node_id: orcaNodeId,
      display_name: config.display_name,
      endpoint: actualEndpoint,
      runtime,
      max_task_ttl_s: maxTaskTtlS,
    });
    peers.upsert(response.self);
    membership.observeInbound(response.self.orca_node_id);
    membership.mergeRemote(response.members);
    return response;
  }

  function sendHeartbeat(peerUrl: string): Promise<HeartbeatResponse> {
    return postSigned<HeartbeatResponse>(
      peerUrl,
      "/cluster/heartbeat",
      { orca_node_id: orcaNodeId, busy: tasks.busy(), digest: currentDigest() },
      AbortSignal.timeout(membership.timings.heartbeatTimeoutMs),
    );
  }

  async function heartbeat(peerUrl: string): Promise<HeartbeatResponse> {
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
      return response;
    } catch (error) {
      if (peer) membership.observeOutboundFail(peer.orca_node_id);
      throw error;
    }
  }

  /** Signed JSON-RPC call to a peer's /a2a endpoint (§4.7). */
  async function postA2a<T>(peerUrl: string, method: string, params: unknown): Promise<T> {
    const url = new URL("/a2a", peerUrl);
    const body = JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params });
    const response = await httpFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: buildAuthHeader({ key, orcaNodeId, method: "POST", path: url.pathname, body }),
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
    dispatches.save({
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
    });
  }

  async function tracked<T extends TaskView>(peerUrl: string, call: Promise<T>): Promise<T> {
    const view = await call;
    rememberDispatch(peerUrl, view);
    return view;
  }

  async function sendTask(peerUrl: string, input: SubmitTaskInput): Promise<TaskView> {
    const peer = membership.findByEndpoint(peerUrl);
    if (peer && peer.state !== "online") {
      const error = new Error(`peer ${peer.orca_node_id} is ${peer.state}`) as Error & { code: string };
      error.code = "peer_not_online";
      throw error;
    }
    return tracked(peerUrl, postA2a<TaskView>(peerUrl, "message/send", input));
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
        key,
        parent: options.parentGrant,
        request,
        selfOrcaNodeId: orcaNodeId,
        ...(options.ttlS !== undefined ? { ttlS: options.ttlS } : {}),
      });
    } else {
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + (options.ttlS ?? GRANT_TTL_S) * 1000);
      const grant: Grant = {
        grant_id: randomUUID(),
        workgroup_id: config.workgroup_id,
        task_id: view.id,
        target_orca_node: request.requested_by,
        tool: request.tool,
        mode: options.mode ?? "allow_once",
        chain: request.via,
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      };
      signed = signGrant(key, grant);
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

  function scheduleHeartbeat(): void {
    if (heartbeatStopped) return;
    const { intervalMs } = membership.timings;
    const delay = intervalMs * (0.8 + Math.random() * 0.4);
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

  /** DNS lookups are not free, so each endpoint is judged once per process. */
  async function candidateAllowed(peer: PeerView): Promise<boolean> {
    const cached = candidateVerdicts.get(peer.endpoint);
    if (cached !== undefined) return cached;
    const allowed = await candidateEndpointAllowed(peer.endpoint, candidatePolicy);
    candidateVerdicts.set(peer.endpoint, allowed);
    if (!allowed && !warnedCandidates.has(peer.orca_node_id)) {
      warnedCandidates.add(peer.orca_node_id);
      console.warn(`orca-pod: refusing candidate endpoint ${peer.endpoint} from ${peer.orca_node_id} (§7.7)`);
    }
    return allowed;
  }

  async function dialableCandidates(peers: PeerView[]): Promise<PeerView[]> {
    const allowed: PeerView[] = [];
    for (const peer of peers) {
      if (membership.originOf(peer.orca_node_id) !== "candidate" || (await candidateAllowed(peer))) {
        allowed.push(peer);
      }
    }
    return allowed;
  }

  async function heartbeatTick(): Promise<void> {
    if (heartbeatStopped) return;
    membership.evaluate();
    const now = membership.now();
    const targets = membership
      .list()
      .filter((peer) => peer.endpoint && membership.needsProbe(peer.orca_node_id, now));
    const dialable = await dialableCandidates(targets);
    await Promise.allSettled(dialable.map((peer) => heartbeat(peer.endpoint)));
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
    const address = await app.listen({ host: config.bind.host, port: config.bind.port });
    boundPort = Number(new URL(address).port);
    actualEndpoint = endpointFrom(config, boundPort);
    gatewayOrcaNode.endpoint = actualEndpoint;
    heartbeatStopped = false;
    void heartbeatTick();
    return { url: actualEndpoint, port: boundPort };
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
    get endpoint(): string {
      return actualEndpoint;
    },
    start,
    stop,
    self,
    members,
    membersDigest: currentDigest,
    join,
    heartbeat,
    sendTask,
    getTask,
    cancelTask,
    approveTask,
    denyTask,
    escalateTask,
    linkChildTask,
    listDispatches: () => dispatches.list(),
  };
}
