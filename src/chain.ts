import { randomUUID } from "node:crypto";

import { signGrant, verifyGrant } from "./crypto.ts";
import {
  TaskError,
  isPermissionMode,
  type Grant,
  type PermissionRequest,
  type PodTaskMetadata,
  type SignedGrant,
} from "./protocol.ts";

/** Delegation limits this orca node enforces on incoming tasks (§5.1, §6.4). */
export type DelegationConfig = {
  /** Accept `pod.hop > 0` up to this many hops; default 0 (single hop only). */
  max_hop?: number;
};

/**
 * Metadata a child task inherits from the task whose agent created it (§5.1).
 * The gateway is the only place that increments the hop and appends the chain;
 * agents cannot write these fields themselves.
 */
export function childPodMetadata(
  parent: PodTaskMetadata | undefined,
  parentTaskId: string,
  selfOrcaNodeId: string,
): PodTaskMetadata {
  return {
    hop: (parent?.hop ?? 0) + 1,
    chain: [...(parent?.chain ?? []), selfOrcaNodeId],
    root: parent?.root ?? parentTaskId,
    ...(parent?.permission_mode !== undefined ? { permission_mode: parent.permission_mode } : {}),
  };
}

/**
 * Validate the `pod` block of an incoming task (§5.1). Throws `hop_limit` when
 * the task crossed more hops than this node accepts, and
 * `ancestor_call_forbidden` when the ancestor path already contains this node.
 */
export function validatePodMetadata(
  metadata: Record<string, unknown> | undefined,
  selfOrcaNodeId: string,
  maxHop = 0,
): PodTaskMetadata {
  const raw = metadata?.["pod"];
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TaskError("bad_request", "metadata.pod must be an object");
  }
  const pod = raw as Record<string, unknown>;
  const hop = pod["hop"];
  if (hop !== undefined && (typeof hop !== "number" || !Number.isInteger(hop) || hop < 0)) {
    throw new TaskError("bad_request", "pod.hop must be a non-negative integer");
  }
  const chain = pod["chain"];
  if (chain !== undefined && (!Array.isArray(chain) || chain.some((entry) => typeof entry !== "string"))) {
    throw new TaskError("bad_request", "pod.chain must be an array of orca node ids");
  }
  const root = pod["root"];
  if (root !== undefined && typeof root !== "string") {
    throw new TaskError("bad_request", "pod.root must be a task id");
  }
  const permissionMode = pod["permission_mode"];
  if (permissionMode !== undefined && !isPermissionMode(permissionMode)) {
    throw new TaskError(
      "bad_request",
      "pod.permission_mode must be one of read-only, workspace-write, danger-full-access",
    );
  }
  const path = (chain as string[] | undefined) ?? [];
  if (typeof hop === "number" && hop > maxHop) {
    throw new TaskError("hop_limit", `task hop ${hop} exceeds this orca node's max_hop ${maxHop}`);
  }
  if (path.includes(selfOrcaNodeId)) {
    throw new TaskError(
      "ancestor_call_forbidden",
      `pod.chain already contains ${selfOrcaNodeId}; ancestors cannot be called back`,
    );
  }
  const normalized: PodTaskMetadata = { hop: typeof hop === "number" ? hop : 0, chain: path };
  if (typeof root === "string") normalized.root = root;
  if (isPermissionMode(permissionMode)) normalized.permission_mode = permissionMode;
  return normalized;
}

/** Why a child grant cannot be derived from this parent, or null when it can. */
export function grantCovers(
  parent: SignedGrant,
  request: Pick<PermissionRequest, "tool">,
  nowMs = Date.now(),
): string | null {
  if (parent.tool !== request.tool) return "escalation_required";
  if (Number.isNaN(Date.parse(parent.expires_at)) || Date.parse(parent.expires_at) <= nowMs) {
    return "grant_expired";
  }
  return null;
}

export type DeriveChildGrantInput = {
  key: Buffer;
  /** Grant the current node received for the task that is asking to delegate. */
  parent: SignedGrant;
  /** Permission request hanging off the child task. */
  request: PermissionRequest;
  /** This orca node, appended to the derived grant's chain. */
  selfOrcaNodeId: string;
  /** Child grant lifetime; defaults to 300s. Never outlives the parent. */
  ttlS?: number;
  now?: Date;
};

/**
 * Derive a child grant from the grant this node holds (§7.12). Deriving instead
 * of forwarding the parent keeps every hop's origin auditable and makes the
 * result necessarily narrower: same tool, chain plus this node, expiry no later
 * than the parent's.
 */
export function deriveChildGrant(options: DeriveChildGrantInput): SignedGrant {
  const now = options.now ?? new Date();
  if (!verifyGrant(options.key, options.parent)) {
    throw new TaskError("grant_invalid", "parent grant signature does not verify");
  }
  const failure = grantCovers(options.parent, options.request, now.getTime());
  if (failure === "escalation_required") {
    throw new TaskError(
      "escalation_required",
      `parent grant covers "${options.parent.tool}", not "${options.request.tool}"`,
    );
  }
  if (failure === "grant_expired") {
    throw new TaskError("grant_expired", "parent grant has expired");
  }
  const ttlMs = (options.ttlS ?? 300) * 1000;
  const parentExpires = Date.parse(options.parent.expires_at);
  const expiresAt = Math.min(now.getTime() + ttlMs, parentExpires);
  const grant: Grant = {
    grant_id: randomUUID(),
    workgroup_id: options.parent.workgroup_id,
    task_id: options.request.task_id,
    target_orca_node: options.request.requested_by,
    tool: options.request.tool,
    mode: options.parent.mode,
    chain: [...options.parent.chain, options.selfOrcaNodeId],
    issued_at: now.toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  };
  return signGrant(options.key, grant);
}
