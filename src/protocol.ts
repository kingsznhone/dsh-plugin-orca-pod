import { createHash, randomBytes } from "node:crypto";

import { isNodeId } from "./identity.ts";

export const PROTOCOL_VERSION = "0.1.0";
export const DEFAULT_PORT = 11811;
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

/** One model route an orca node advertises for tasks (§6.16). */
export type ModelOffer = {
  provider: string;
  model: string;
  /** Human-readable model name, when the provider catalog publishes one. */
  name?: string;
  description?: string;
};

/** A provider/model route, optionally pinned to one reasoning effort. */
export type ModelSelection = {
  provider: string;
  model: string;
  reasoning_effort?: string;
};

export type PeerView = {
  orca_node_id: OrcaNodeId;
  display_name: string;
  /** Base URLs peers may dial, best first; one entry is the common case (§3.2). */
  endpoints: string[];
  runtime: RuntimeInfo | null;
  runtime_digest: string;
  state: PeerState;
  busy: BusyState | null;
  last_recv_at: string | null;
  /** Per-task time budget this orca node enforces; origins size tasks to it (§6.9). */
  max_task_ttl_s?: number;
  /** Model routes this orca node can switch an ACP session to (§6.16). */
  models?: ModelOffer[];
  /** The model an ACP session uses when a task does not name one (§6.16). */
  default_model?: ModelSelection | null;
};

export type SelfRecord = PeerView & {
  workgroup_id: WorkgroupId;
  protocol_version: string;
};

export type JoinRequest = {
  workgroup_id: WorkgroupId;
  orca_node_id: OrcaNodeId;
  display_name: string;
  endpoints: string[];
  runtime: RuntimeInfo | null;
  max_task_ttl_s?: number;
  models?: ModelOffer[];
  default_model?: ModelSelection | null;
};

export type JoinResponse = {
  self: SelfRecord;
  members: PeerView[];
  members_digest: string;
};

export type HeartbeatRequest = {
  workgroup_id: string;
  orca_node_id: OrcaNodeId;
  /** Admission proof derived from the workgroup password (§7.1); heartbeats carry it too. */
  ts: number;
  nonce: string;
  proof: string;
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

/**
 * An orca node id is the base64url-encoded raw Ed25519 public key (§7.1), so a
 * valid id is self-certifying: whoever signs with the matching private key owns
 * the id, and no shared workgroup secret can stand in for it.
 */
export function normalizeOrcaNodeId(raw: string): OrcaNodeId | null {
  const value = raw.trim();
  return isNodeId(value) ? value : null;
}

export function isOrcaNodeId(value: unknown): value is OrcaNodeId {
  return isNodeId(value);
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
  peers: ReadonlyArray<Pick<PeerView, "orca_node_id" | "endpoints" | "runtime_digest">>,
): string {
  const lines = peers
    .map((peer) => `${peer.orca_node_id}|${peer.endpoints.join(",")}|${peer.runtime_digest}`)
    .sort();
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

/** Max advertised base URLs per orca node; enough for IPv4/IPv6/LAN/public. */
export const MAX_ENDPOINTS = 8;

/**
 * Validate and normalize an advertised endpoint list: http(s) base URLs with no
 * trailing slash, deduplicated, order preserved (first is preferred).
 */
export function normalizeEndpoints(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENDPOINTS) return null;
  const endpoints: string[] = [];
  for (const item of value) {
    if (!isHttpEndpoint(item)) return null;
    const endpoint = item.endsWith("/") ? item.slice(0, -1) : item;
    if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  return endpoints.length > 0 ? endpoints : null;
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

/** Token spend reported by the executor, when it reports one (§6.14). */
export type TaskUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
};

export type TaskView = {
  kind: "task";
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: TaskArtifact[];
  usage?: TaskUsage;
  metadata?: Record<string, unknown>;
};

/** How much an agent may do on the orca node running its task (§7.10). */
export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

/** Rank of a mode; a higher rank lets the agent do more. */
export function permissionModeRank(mode: PermissionMode): number {
  return PERMISSION_MODES.indexOf(mode);
}

/** The narrower of two modes: an inherited mode can only lower the local ceiling. */
export function narrowPermissionMode(local: PermissionMode, inherited: PermissionMode): PermissionMode {
  return permissionModeRank(inherited) < permissionModeRank(local) ? inherited : local;
}

/** Read `permission_mode` out of a task's `metadata.pod` block, if valid. */
export function permissionModeOf(metadata: Record<string, unknown> | undefined): PermissionMode | undefined {
  const pod = metadata?.["pod"];
  if (typeof pod !== "object" || pod === null) return undefined;
  const mode = (pod as Record<string, unknown>)["permission_mode"];
  return isPermissionMode(mode) ? mode : undefined;
}

/** True when `value` names a provider/model route with optional reasoning effort. */
export function isModelSelection(value: unknown): value is ModelSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["provider"] !== "string" || record["provider"].length === 0) return false;
  if (typeof record["model"] !== "string" || record["model"].length === 0) return false;
  const effort = record["reasoning_effort"];
  return effort === undefined || (typeof effort === "string" && effort.length > 0);
}

/** Parse a `provider/model` spec, optionally with a reasoning effort (§6.16). */
export function parseModelSpec(spec: string, reasoningEffort?: string): ModelSelection | null {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return null;
  const provider = spec.slice(0, slash).trim();
  const model = spec.slice(slash + 1).trim();
  if (provider.length === 0 || model.length === 0) return null;
  const reasoning = reasoningEffort?.trim();
  return {
    provider,
    model,
    ...(reasoning !== undefined && reasoning.length > 0 ? { reasoning_effort: reasoning } : {}),
  };
}

/** Read `metadata.pod.model` out of a task submission, if valid (§6.16). */
export function modelSelectionOf(metadata: Record<string, unknown> | undefined): ModelSelection | undefined {
  const pod = metadata?.["pod"];
  if (typeof pod !== "object" || pod === null) return undefined;
  const selection = (pod as Record<string, unknown>)["model"];
  return isModelSelection(selection) ? selection : undefined;
}

export type PodTaskMetadata = {
  hop?: number;
  chain?: string[];
  root?: string;
  /** Origin session mode; the target never runs above it (§7.10). */
  permission_mode?: PermissionMode;
  /** Model route the target's ACP executor should select for this task (§6.16). */
  model?: ModelSelection;
  idempotency_key?: string;
  task_ttl_s?: number;
  grant_id?: string;
  /** Blobs the target materializes under `inputs/<task_id>/` before the run (§6.7). */
  inputs?: Array<{ blob_id: string; name: string }>;
};

/**
 * A suspended task's ask for one tool outside the origin's grant (§7.11,
 * §7.12). It lives in `status.message`, so the origin discovers it by reading
 * task state; nothing is pushed to it.
 */
export type PermissionRequest = {
  request_id: string;
  task_id: string;
  tool: string;
  requested: Record<string, unknown>;
  /** Orca node that needs the permission (the one running the task). */
  requested_by: string;
  /** Chain from this orca node up to the origin that can decide. */
  via: string[];
  /** Orca nodes further down the chain that actually need the permission (§7.12 relay). */
  upstream?: string[];
  /** Present only when the executing orca node configures an approval timeout (§7.12). */
  expires_at?: string;
};

/**
 * A human decision travelling from the origin back down to the target (§7.11).
 * Signed by the origin node's Ed25519 key: the transport is already
 * authenticated, but a grant is also the durable record of who allowed what.
 */
export type GrantMode = "allow_once";

export type Grant = {
  grant_id: string;
  workgroup_id: string;
  /** Orca node whose signature authorizes this grant (the deciding origin). */
  origin_orca_node: string;
  task_id: string;
  target_orca_node: string;
  tool: string;
  mode: GrantMode;
  chain: string[];
  issued_at: string;
  expires_at: string;
};

export type SignedGrant = Grant & { sig: string };

/** Data parts understood by `tasks/resume`; anything else is free-form input. */
export type ResumeControl =
  | { grant: SignedGrant }
  | { permission_denied: true; reason?: string };

/**
 * A child task an orca node is waiting on while it escalates upward (§7.12).
 * The parent task holds this so an approval can be turned into a child grant.
 */
export type TaskRelay = {
  /** Endpoint of the orca node running the child task. */
  peer: string;
  /** Child task id on that orca node. */
  task_id: string;
  /** The child's permission request being escalated. */
  request: PermissionRequest;
};

/** Read the permission request a suspended task carries, if any (§7.11). */
export function permissionRequestOf(view: TaskView): PermissionRequest | null {
  for (const part of view.status.message?.parts ?? []) {
    if (part.kind !== "data") continue;
    const request = (part.data as { permission_request?: unknown }).permission_request;
    if (typeof request === "object" && request !== null) return request as PermissionRequest;
  }
  return null;
}

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
  resume(taskId: string, message: A2AMessage, callerOrcaNode?: OrcaNodeId): TaskView;
  /**
   * Suspend a running task because a child task it delegated to needs a
   * permission only this task's origin can grant (§7.12). The parent task goes
   * `input-required` with an upstream request; an approval derives a child
   * grant from the parent grant and resumes the child.
   */
  escalate(taskId: string, relay: TaskRelay, callerOrcaNode?: OrcaNodeId): TaskView;
  cancel(taskId: string): TaskView;
  /** Origin of a known task, used by the gateway to authorize cancellation (§5.3). */
  originOf(taskId: string): OrcaNodeId | null;
  /** Currently running task (single-slot, §6.9); null when idle. */
  busy(): BusyState | null;
  /**
   * Local (inbound) tasks, newest first, for the UI task panel (§9.2). In-memory
   * records come first, then the persisted store fills the remaining budget.
   */
  list(limit?: number): TaskView[];
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

