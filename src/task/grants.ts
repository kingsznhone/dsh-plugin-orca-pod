/**
 * Permission grants on the target side (§7.11): a grant crosses the trust
 * boundary in a resume message (parsed by `parseResume`), and `GrantLedger.accept`
 * verifies it and remembers it in one step.
 */

import type { PodErrorCode } from "../core/errors.ts";
import { signWithIdentity, verifyWithNodeId, type NodeIdentity } from "../core/identity.ts";
import type { Grant, PermissionRequest, SignedGrant } from "../core/wire/grant.ts";
import type { OrcaNodeId, WorkgroupId } from "../core/wire/peer.ts";

const GRANT_DOMAIN = "orca-pod/grant";

/** What a grant has to match: the task that waits and the request it is parked on. */
type GrantExpectation = {
  taskId: string;
  selfOrcaNodeId: OrcaNodeId;
  workgroupId: WorkgroupId;
  /** Origin of the task: the only node whose decision counts (§7.11). */
  origin: OrcaNodeId;
  pending: PermissionRequest;
};

/** Why a grant is not accepted: a `PodErrorCode`, and the `reason` the task fails with. */
export type GrantFailure = Extract<PodErrorCode, "grant_invalid" | "grant_expired" | "grant_replayed">;

const LEDGER_LIMIT = 1024;

/**
 * A grant answers one request once: remembering its id until it expires turns a
 * replay into `grant_replayed` instead of a second upgrade (§7.11).
 */
export class GrantLedger {
  private readonly consumed = new Map<string, number>();

  /**
   * Returns the failure reason, or null when the grant is genuine, matches what
   * was asked and has not been seen before; then it is remembered, so the same
   * grant is never accepted twice.
   */
  accept(grant: SignedGrant, expected: GrantExpectation): GrantFailure | null {
    const now = Date.now();
    if (!verifyGrant(grant.origin_orca_node, grant)) return "grant_invalid";
    if (grant.origin_orca_node !== expected.origin) return "grant_invalid";
    if (grant.workgroup_id !== expected.workgroupId) return "grant_invalid";
    if (grant.tool !== expected.pending.tool) return "grant_invalid";
    // The origin grants exactly the mode the task asked for; the target already checked it against its ceiling.
    if (grant.permission_mode !== expected.pending.requested_mode) return "grant_invalid";
    if (Date.parse(grant.expires_at) <= now) return "grant_expired";
    // The grant allows exactly the request this task is parked on, for this task on this node.
    if (grant.request_id !== expected.pending.request_id) return "grant_invalid";
    const seenUntil = this.consumed.get(grant.grant_id);
    if (seenUntil !== undefined && seenUntil > now) return "grant_replayed";
    if (grant.task_id !== expected.taskId || grant.target_orca_node !== expected.selfOrcaNodeId) return "grant_invalid";
    this.remember(grant, now);
    return null;
  }

  private remember(grant: SignedGrant, now: number): void {
    if (this.consumed.size >= LEDGER_LIMIT) {
      for (const [id, expiresAt] of this.consumed) if (expiresAt <= now) this.consumed.delete(id);
      // Still full of live grants: forget the oldest rather than grow without bound.
      const oldest = this.consumed.keys().next();
      if (this.consumed.size >= LEDGER_LIMIT && !oldest.done) this.consumed.delete(oldest.value);
    }
    this.consumed.set(grant.grant_id, Date.parse(grant.expires_at));
  }
}

// ---------------------------------------------------------------------------
// Grants (§7.11): the origin node signs its human decision with its own key.
// ---------------------------------------------------------------------------

/**
 * The signature covers every grant field, including the deciding origin and the
 * request id. Writing them as canonical JSON (fixed key order, no optional
 * trailing fields) avoids the ambiguity of `|`-joined values: a grant cannot be
 * re-labelled with a different origin or replayed for another request.
 */
function grantSignatureInput(grant: Grant): string {
  return `${GRANT_DOMAIN}\n${JSON.stringify({
    grant_id: grant.grant_id,
    workgroup_id: grant.workgroup_id,
    origin_orca_node: grant.origin_orca_node,
    task_id: grant.task_id,
    target_orca_node: grant.target_orca_node,
    tool: grant.tool,
    permission_mode: grant.permission_mode,
    request_id: grant.request_id,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at,
  })}`;
}

export function signGrant(identity: NodeIdentity, grant: Grant): SignedGrant {
  const sig = signWithIdentity(identity, grantSignatureInput(grant));
  return { ...grant, sig };
}

/** Verify a grant against the origin node that signed it. */
function verifyGrant(originOrcaNodeId: OrcaNodeId, grant: SignedGrant): boolean {
  if (typeof grant.sig !== "string" || grant.sig.length === 0) return false;
  return verifyWithNodeId(originOrcaNodeId, grantSignatureInput(grant), grant.sig);
}
