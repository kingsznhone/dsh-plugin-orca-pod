import { createHash, randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = "0.1.0";
export const DEFAULT_PORT = 11811;
export const NODE_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const NODE_ID_LENGTH = 6;
export const WORKGROUP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

export const ERROR_CODES = [
  "missing_auth",
  "malformed_auth",
  "clock_skew",
  "nonce_replay",
  "bad_proof",
  "bad_request",
  "workgroup_mismatch",
  "node_id_conflict",
  "unknown_node",
  "not_found",
  "node_busy",
  "unsupported",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type NodeId = string;
export type WorkgroupId = string;
export type PeerState = "unknown" | "online" | "suspect" | "offline";

export type RuntimeInfo = {
  os: { family: string; name: string; version: string };
  arch: string;
  cpu: { model: string; logical_cores: number };
  memory: { total_bytes: number };
  node: { version: string };
  captured_at: string;
};

export type BusyState = {
  task_id: string;
  origin_node: NodeId;
  since: string;
};

export type PeerView = {
  node_id: NodeId;
  display_name: string;
  endpoint: string;
  runtime: RuntimeInfo | null;
  runtime_digest: string;
  state: PeerState;
  busy: BusyState | null;
  last_recv_at: string | null;
};

export type SelfRecord = PeerView & {
  workgroup_id: WorkgroupId;
  protocol_version: string;
};

export type JoinRequest = {
  workgroup_id: WorkgroupId;
  node_id: NodeId;
  display_name: string;
  endpoint: string;
  runtime: RuntimeInfo | null;
};

export type JoinResponse = {
  self: SelfRecord;
  members: PeerView[];
  members_digest: string;
};

export type HeartbeatRequest = {
  node_id: NodeId;
  busy: BusyState | null;
  digest: string | null;
};

export type HeartbeatResponse = {
  from: NodeId;
  members_digest: string;
  members: PeerView[] | null;
};

export type MembersResponse = {
  members_digest: string;
  members: PeerView[];
};

export function generateNodeId(bytes: Uint8Array = randomBytes(5)): NodeId {
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += NODE_ID_ALPHABET[(acc >>> bits) & 0x1f];
    }
    acc &= (1 << bits) - 1;
    if (out.length >= NODE_ID_LENGTH) break;
  }
  while (out.length < NODE_ID_LENGTH) out += NODE_ID_ALPHABET[0];
  return out;
}

export function normalizeNodeId(raw: string): NodeId | null {
  const value = raw.trim().toUpperCase();
  return isNodeId(value) ? value : null;
}

export function isNodeId(value: unknown): value is NodeId {
  if (typeof value !== "string" || value.length !== NODE_ID_LENGTH) return false;
  for (const char of value) {
    if (!NODE_ID_ALPHABET.includes(char)) return false;
  }
  return true;
}

export function isWorkgroupId(value: unknown): value is WorkgroupId {
  return typeof value === "string" && WORKGROUP_ID_PATTERN.test(value);
}

export function runtimeDigest(runtime: RuntimeInfo | null): string {
  if (!runtime) return "none";
  const stable = [
    runtime.os.family,
    runtime.os.name,
    runtime.os.version,
    runtime.arch,
    runtime.cpu.model,
    String(runtime.cpu.logical_cores),
    String(runtime.memory.total_bytes),
    runtime.node.version,
  ].join("|");
  return createHash("sha256").update(stable).digest("hex");
}

export function membersDigest(
  peers: ReadonlyArray<Pick<PeerView, "node_id" | "endpoint" | "runtime_digest">>,
): string {
  const lines = peers.map((peer) => `${peer.node_id}|${peer.endpoint}|${peer.runtime_digest}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function isHttpEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
