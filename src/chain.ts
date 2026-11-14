import { randomUUID } from "node:crypto";

import { verifyGrant } from "./crypto.ts";
import {
  TaskError,
  isPermissionMode,
  type Grant,
  type PermissionRequest,
  type PodTaskMetadata,
  type SignedGrant,
} from "./protocol.ts";

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
 * Validate the `pod` block of an incoming task (§5.1, §6.4). There is no hop
 * limit — a workgroup is a handful of machines — so only malformed metadata and
 * a callback to an ancestor (`ancestor_call_forbidden`) are rejected.
 */
export function validatePodMetadata(
  metadata: Record<string, unknown> | undefined,
  selfOrcaNodeId: string,
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
  /** Grant the current node received for the task that is asking to delegate. */
  parent: SignedGrant;
  /** Permission request hanging off the child task. */
  request: PermissionRequest;
  /** This orca node, which must be the parent grant's target. */
  selfOrcaNodeId: string;
  now?: Date;
};

/**
 * Validate that the origin's grant covers a child permission request (§7.12).
 *
 * Only the origin signs grants, and it signs once for the task it decided. A
 * middle node therefore does not mint a new grant: it forwards the origin's
 * signed grant unchanged, and the child accepts it because the origin named an
 * ancestor of the child's delegation chain (§7.11, `checkGrant`). This keeps a
 * single signature authority and cannot widen scope: same tool, same expiry.
 */
export function deriveChildGrant(options: DeriveChildGrantInput): SignedGrant {
  const now = options.now ?? new Date();
  if (!verifyGrant(options.parent.origin_orca_node, options.parent)) {
    throw new TaskError("grant_invalid", "parent grant signature does not verify");
  }
  if (options.parent.target_orca_node !== options.selfOrcaNodeId) {
    throw new TaskError("grant_invalid", "parent grant was issued to another orca node");
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
  return options.parent;
}
