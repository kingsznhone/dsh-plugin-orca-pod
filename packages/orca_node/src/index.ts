import { cpus, platform as osPlatform, release as osRelease, totalmem } from "node:os";

import { workgroupKey, type NodeConfig } from "@orca/config";
import { buildAuthHeader, NonceCache } from "@orca/crypto";
import { createGateway } from "@orca/gateway";
import {
  membersDigest as computeMembersDigest,
  PROTOCOL_VERSION,
  runtimeDigest,
  type HeartbeatResponse,
  type JoinResponse,
  type PeerView,
  type RuntimeInfo,
  type SelfRecord,
} from "@orca/protocol";
import { createMemoryPeerStore, type PeerStore } from "@orca/storage";

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
};

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
  const peers: PeerStore = createMemoryPeerStore();
  const nonceCache = new NonceCache();
  const runtime = options.runtime ?? collectRuntime();

  let boundPort = config.bind.port;
  let actualEndpoint = endpointFrom(config, boundPort);

  const gatewayNode: GatewayNodeInfo = {
    node_id: nodeId,
    display_name: config.display_name,
    workgroup_id: config.workgroup_id,
    endpoint: actualEndpoint,
  };
  const app = createGateway({ node: gatewayNode, key, peers, nonceCache, runtime });

  function selfPeer(): PeerView {
    return {
      node_id: nodeId,
      display_name: config.display_name,
      endpoint: actualEndpoint,
      runtime,
      runtime_digest: runtimeDigest(runtime),
      state: "online",
      busy: null,
      last_recv_at: new Date().toISOString(),
    };
  }

  function roster(): PeerView[] {
    return [...peers.list(), selfPeer()];
  }

  function self(): SelfRecord {
    return { ...selfPeer(), workgroup_id: config.workgroup_id, protocol_version: PROTOCOL_VERSION };
  }

  function members(): PeerView[] {
    return peers.list();
  }

  function currentDigest(): string {
    return computeMembersDigest(roster());
  }

  function rememberMembers(list: PeerView[] | null): void {
    if (!list) return;
    for (const member of list) {
      if (member.node_id === nodeId) continue;
      peers.upsert(member);
    }
  }

  async function postSigned<T>(peerUrl: string, path: string, payload: unknown): Promise<T> {
    const url = new URL(path, peerUrl);
    const body = JSON.stringify(payload);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: buildAuthHeader({ key, nodeId, method: "POST", path: url.pathname, body }),
      },
      body,
    });
    if (!response.ok) {
      const { code } = (await response.json()) as { code: string };
      throw new Error(`${path} ${response.status}: ${code}`);
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
    rememberMembers([response.self, ...response.members]);
    return response;
  }

  async function heartbeat(peerUrl: string): Promise<HeartbeatResponse> {
    const response = await postSigned<HeartbeatResponse>(peerUrl, "/cluster/heartbeat", {
      node_id: nodeId,
      busy: null,
      digest: currentDigest(),
    });
    rememberMembers(response.members);
    return response;
  }

  async function start(): Promise<{ url: string; port: number }> {
    const address = await app.listen({ host: config.bind.host, port: config.bind.port });
    boundPort = Number(new URL(address).port);
    actualEndpoint = endpointFrom(config, boundPort);
    gatewayNode.endpoint = actualEndpoint;
    return { url: actualEndpoint, port: boundPort };
  }

  async function stop(): Promise<void> {
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
  };
}
