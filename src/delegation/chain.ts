import { verifyGrant } from "../security/index.ts";
import { PodError } from "../kernel/index.ts";
import type { PermissionRequest, PodTaskMetadata, SignedGrant } from "../protocol/index.ts";

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
    ...(parent?.root_origin !== undefined ? { root_origin: parent.root_origin } : {}),
    ...(parent?.permission_mode !== undefined ? { permission_mode: parent.permission_mode } : {}),
  };
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

type DeriveChildGrantInput = {
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
    throw new PodError("grant_invalid", "parent grant signature does not verify");
  }
  if (options.parent.target_orca_node !== options.selfOrcaNodeId) {
    throw new PodError("grant_invalid", "parent grant was issued to another orca node");
  }
  const failure = grantCovers(options.parent, options.request, now.getTime());
  if (failure === "escalation_required") {
    throw new PodError(
      "escalation_required",
      `parent grant covers "${options.parent.tool}", not "${options.request.tool}"`,
    );
  }
  if (failure === "grant_expired") {
    throw new PodError("grant_expired", "parent grant has expired");
  }
  return options.parent;
}
