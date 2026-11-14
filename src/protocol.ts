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
  "orca_node_id_conflict",
  "unknown_orca_node",
  "not_found",
  "orca_node_busy",
  "bad_echo_script",
  "task_not_found",
  "task_not_terminal",
  "unsupported",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type OrcaNodeId = string;
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
  origin_orca_node: OrcaNodeId;
  since: string;
};

export type PeerView = {
  orca_node_id: OrcaNodeId;
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
  orca_node_id: OrcaNodeId;
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
  orca_node_id: OrcaNodeId;
  busy: BusyState | null;
  /** 本 orca node 当前成员视图的摘要；与对端不一致时对端会回目录（候选端点）。 */
  digest: string | null;
};

export type HeartbeatResponse = {
  from: OrcaNodeId;
  busy: BusyState | null;
  members_digest: string;
  /** 仅当请求摘要与本地不一致时返回；只是候选端点，不声明在线。 */
  members: PeerView[] | null;
};

export type MembersResponse = {
  members_digest: string;
  members: PeerView[];
};

export function generateOrcaNodeId(bytes: Uint8Array = randomBytes(5)): OrcaNodeId {
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

export function normalizeOrcaNodeId(raw: string): OrcaNodeId | null {
  const value = raw.trim().toUpperCase();
  return isOrcaNodeId(value) ? value : null;
}

export function isOrcaNodeId(value: unknown): value is OrcaNodeId {
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
  peers: ReadonlyArray<Pick<PeerView, "orca_node_id" | "endpoint" | "runtime_digest">>,
): string {
  const lines = peers.map((peer) => `${peer.orca_node_id}|${peer.endpoint}|${peer.runtime_digest}`).sort();
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

// ---------------------------------------------------------------------------
// A2A task surface (§4.7, §4.8, §5.1)
// ---------------------------------------------------------------------------

export type TaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";

export const TERMINAL_STATES: ReadonlyArray<TaskState> = ["completed", "failed", "canceled"];

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "data"; data: Record<string, unknown> }
  | { kind: "file"; file: { name: string; mimeType?: string; bytes?: string } };

export type A2AMessage = {
  role: "user" | "agent";
  parts: MessagePart[];
  messageId?: string;
  /** Set when this message continues an input-required task (§4.8). */
  taskId?: string;
  contextId?: string;
};

/** Suspended payload lives in `status.message`; it is task state, not a push (§4.7). */
export type TaskStatus = {
  state: TaskState;
  timestamp: string;
  message?: A2AMessage;
  reason?: string;
};

export type TaskArtifact = {
  artifactId: string;
  name: string;
  mediaType?: string;
  bytes: number;
};

export type TaskView = {
  kind: "task";
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: TaskArtifact[];
  metadata?: Record<string, unknown>;
};

export type PodTaskMetadata = {
  hop?: number;
  chain?: string[];
  root?: string;
  notify?: "auto" | "inbox" | "wake";
  continuation_of?: string | null;
  idempotency_key?: string;
  task_ttl_s?: number;
  grant_id?: string;
};

export type SubmitTaskInput = {
  message: A2AMessage;
  metadata?: Record<string, unknown> & { pod?: PodTaskMetadata };
  /** Authenticated origin; recorded on the task for busy/holder reporting (§6.9). */
  originOrcaNode?: OrcaNodeId;
};

/** Implemented by orca_node (needs an executor), consumed by the gateway. */
export interface TaskRunner {
  submit(input: SubmitTaskInput): TaskView;
  get(taskId: string): TaskView | null;
  resume(taskId: string, message: A2AMessage): TaskView;
  cancel(taskId: string): TaskView;
  /** Currently running task (single-slot, §6.9); null when idle. */
  busy(): BusyState | null;
  /** Fail tasks that were interrupted by a restart (§8.3); returns how many. */
  recover(): number;
}

/** Task-level failure carrying a stable code for the gateway's HTTP mapping. */
export class TaskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}


const TASK_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID-shaped task id: 48-bit millisecond timestamp + 80 random bits, base32.
 * Time-ordered, 26 chars, unguessable enough to act as a capability handle (§5.5).
 */
export function newTaskId(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  let value = BigInt(now & 0xffffffffffff) << 80n;
  for (const byte of random.subarray(0, 10)) value = (value << 8n) | BigInt(byte);
  let out = "";
  for (let index = 0; index < 26; index += 1) {
    out = TASK_ID_ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

