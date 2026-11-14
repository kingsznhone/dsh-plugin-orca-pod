import { randomUUID } from "node:crypto";
import { cpus, platform as osPlatform, release as osRelease, totalmem } from "node:os";

import { workgroupKey, type NodeConfig } from "./config.ts";
import { buildAuthHeader, NonceCache } from "./crypto.ts";
import { EchoExecutor } from "./executor.ts";
import { createGateway } from "./gateway.ts";
import { createMembership, type MembershipClock, type MembershipTimings } from "./membership.ts";
import {
  membersDigest as computeMembersDigest,
  PROTOCOL_VERSION,
  runtimeDigest,
  type A2AMessage,
  type HeartbeatResponse,
  type JoinResponse,
  type PeerView,
  type RuntimeInfo,
  type SelfRecord,
  type SubmitTaskInput,
  type TaskView,
} from "./protocol.ts";
import { createMemoryBlobStore, type PeerStore } from "./storage.ts";
import { createTaskRunner } from "./tasks.ts";

/**
 * Gateway dependency record. `endpoint` is mutable: the gateway is built before
 * `listen()` (the port may be 0) and the bound endpoint is written back once the
 * listener is up, so the gateway reads the current value when it renders self.
 */
type GatewayNodeInfo = {
  node_id: string;
  display_name: string;
  workgroup_id: string;
  endpoint: string | null;
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

export type CreateNodeOptions = {
  config: NodeConfig;
  runtime?: RuntimeInfo;
  timings?: Partial<MembershipTimings>;
  clock?: MembershipClock;
  /** Outbound HTTP for peer calls; tests inject packet loss / delay / partitions. */
  fetch?: FetchLike;
};

/** Same shape as the global `fetch`, so a test can wrap it without a library. */
export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

export interface OrcaNode {
  readonly nodeId: string;
  readonly config: NodeConfig;
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
}

/**
 * Join every peer in a directory response, best-effort: one unreachable peer
 * must not stop a node from joining the rest of the mesh (§3.2).
 */
export async function joinRoster(
  node: OrcaNode,
  members: readonly PeerView[],
): Promise<{ joined: string[]; failed: string[] }> {
  const joined: string[] = [];
  const failed: string[] = [];
  for (const member of members) {
    if (member.node_id === node.nodeId || !member.endpoint) continue;
    try {
      await node.join(member.endpoint);
      joined.push(member.node_id);
    } catch {
      failed.push(member.node_id);
    }
  }
  return { joined, failed };
}

/** Address a remote node should dial: wildcard binds are reachable on loopback. */
function endpointFrom(config: NodeConfig, port: number): string {
  if (config.endpoint) return config.endpoint;
  const host = config.bind.host === "0.0.0.0" || config.bind.host === "::" ? "127.0.0.1" : config.bind.host;
  return `http://${host}:${port}`;
}

export function createNode(options: CreateNodeOptions): OrcaNode {
  const { config } = options;
  const nodeId = config.node_id;
  const key = workgroupKey(config);
  const httpFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const membership = createMembership({
    selfNodeId: nodeId,
    timings: options.timings,
    clock: options.clock,
  });
  const peers: PeerStore = membership.peers;
  const nonceCache = new NonceCache();
  const runtime = options.runtime ?? collectRuntime();
  const blobs = createMemoryBlobStore();
  const tasks = createTaskRunner({ executor: new EchoExecutor(), blobs });

  let boundPort = config.bind.port;
  let actualEndpoint = endpointFrom(config, boundPort);

  const gatewayNode: GatewayNodeInfo = {
    node_id: nodeId,
    display_name: config.display_name,
    workgroup_id: config.workgroup_id,
    endpoint: actualEndpoint,
  };
  const app = createGateway({ node: gatewayNode, key, peers, nonceCache, runtime, tasks, blobs });

  function selfPeer(): PeerView {
    return {
      node_id: nodeId,
      display_name: config.display_name,
      endpoint: actualEndpoint,
      runtime,
      runtime_digest: runtimeDigest(runtime),
      state: "online",
      busy: tasks.busy(),
      last_recv_at: new Date().toISOString(),
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
        authorization: buildAuthHeader({ key, nodeId, method: "POST", path: url.pathname, body }),
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
      node_id: nodeId,
      display_name: config.display_name,
      endpoint: actualEndpoint,
      runtime,
    });
    peers.upsert(response.self);
    membership.observeInbound(response.self.node_id);
    membership.mergeRemote(response.members);
    return response;
  }

  function sendHeartbeat(peerUrl: string): Promise<HeartbeatResponse> {
    return postSigned<HeartbeatResponse>(
      peerUrl,
      "/cluster/heartbeat",
      { node_id: nodeId, busy: tasks.busy(), digest: currentDigest() },
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
        // 对端已把本节点记录修剪掉：join 一次让它重新认识我，并带回它的目录。
        await join(peerUrl);
        response = await sendHeartbeat(peerUrl);
      }
      membership.observeInbound(response.from);
      membership.observeOutboundOk(response.from);
      if (response.members) membership.mergeRemote(response.members);
      return response;
    } catch (error) {
      if (peer) membership.observeOutboundFail(peer.node_id);
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
        authorization: buildAuthHeader({ key, nodeId, method: "POST", path: url.pathname, body }),
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

  function sendTask(peerUrl: string, input: SubmitTaskInput): Promise<TaskView> {
    const peer = membership.findByEndpoint(peerUrl);
    if (peer && peer.state !== "online") {
      const error = new Error(`peer ${peer.node_id} is ${peer.state}`) as Error & { code: string };
      error.code = "peer_not_online";
      throw error;
    }
    return postA2a<TaskView>(peerUrl, "message/send", input);
  }

  function getTask(peerUrl: string, taskId: string): Promise<TaskView> {
    return postA2a<TaskView>(peerUrl, "tasks/get", { id: taskId });
  }

  function cancelTask(peerUrl: string, taskId: string): Promise<TaskView> {
    return postA2a<TaskView>(peerUrl, "tasks/cancel", { id: taskId });
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

  async function heartbeatTick(): Promise<void> {
    if (heartbeatStopped) return;
    membership.evaluate();
    const now = membership.now();
    const targets = membership
      .list()
      .filter((peer) => peer.endpoint && membership.needsProbe(peer.node_id, now));
    await Promise.allSettled(targets.map((peer) => heartbeat(peer.endpoint)));
    scheduleHeartbeat();
  }

  async function start(): Promise<{ url: string; port: number }> {
    const address = await app.listen({ host: config.bind.host, port: config.bind.port });
    boundPort = Number(new URL(address).port);
    actualEndpoint = endpointFrom(config, boundPort);
    gatewayNode.endpoint = actualEndpoint;
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
    await app.close();
  }

  return {
    get nodeId(): string {
      return nodeId;
    },
    get config(): NodeConfig {
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
  };
}
