/**
 * Permission grants on the target side (§7.11): a grant crosses the trust
 * boundary in a resume message and is parsed once here (`parseSignedGrant`);
 * `checkGrant` only verifies and never consumes, and the ledger is told
 * separately once a grant has been accepted.
 */

import { verifyGrant } from "./crypto.ts";
import { PodError, type PodErrorCode } from "../kernel/errors.ts";
import { describeIssue, parseSchema } from "../kernel/schema.ts";
import { SignedGrantSchema, type PermissionRequest, type SignedGrant } from "../protocol/grant.ts";
import type { OrcaNodeId, WorkgroupId } from "../protocol/peer.ts";

/** A grant as it arrives in a resume message; the signature is checked later, by `checkGrant`. */
export function parseSignedGrant(raw: unknown): SignedGrant {
  const parsed = parseSchema(SignedGrantSchema, raw);
  if (parsed.ok) return parsed.value;
  throw new PodError("bad_request", `grant ${describeIssue(parsed.issue)}`);
}

/** What a grant has to match: the task that waits and the request it is parked on. */
export type GrantExpectation = {
  taskId: string;
  selfOrcaNodeId: OrcaNodeId;
  workgroupId: WorkgroupId;
  /** Origin of the task: the only node whose decision counts (§7.11). */
  origin: OrcaNodeId;
  pending: PermissionRequest;
};

/** Why a grant is not accepted: a `PodErrorCode`, and the `reason` the task fails with. */
export type GrantFailure = Extract<PodErrorCode, "grant_invalid" | "grant_expired" | "grant_replayed">;

/**
 * Returns the failure reason, or null when the grant is genuine and matches what
 * was asked. Pure: accepting the grant (`GrantLedger.consume`) is the caller's step.
 */
export function checkGrant(
  grant: SignedGrant,
  expected: GrantExpectation,
  ledger: GrantLedger,
  now = Date.now(),
): GrantFailure | null {
  if (!verifyGrant(grant.origin_orca_node, grant)) return "grant_invalid";
  if (grant.origin_orca_node !== expected.origin) return "grant_invalid";
  if (grant.workgroup_id !== expected.workgroupId) return "grant_invalid";
  if (grant.tool !== expected.pending.tool) return "grant_invalid";
  // The origin grants exactly the mode the task asked for; the target already checked it against its ceiling.
  if (grant.permission_mode !== expected.pending.requested_mode) return "grant_invalid";
  if (Date.parse(grant.expires_at) <= now) return "grant_expired";
  // The grant allows exactly the request this task is parked on, for this task on this node.
  if (grant.request_id !== expected.pending.request_id) return "grant_invalid";
  if (ledger.has(grant.grant_id, now)) return "grant_replayed";
  if (grant.task_id !== expected.taskId || grant.target_orca_node !== expected.selfOrcaNodeId) return "grant_invalid";
  return null;
}

const LEDGER_LIMIT = 1024;

/**
 * A grant answers one request once: remembering its id until it expires turns a
 * replay into `grant_replayed` instead of a second upgrade (§7.11).
 */
export type GrantLedger = {
  has(grantId: string, now?: number): boolean;
  consume(grant: SignedGrant): void;
};

export function createGrantLedger(): GrantLedger {
  const consumed = new Map<string, number>();
  return {
    has(grantId, now = Date.now()) {
      const expiresAt = consumed.get(grantId);
      return expiresAt !== undefined && expiresAt > now;
    },
    consume(grant) {
      if (consumed.size >= LEDGER_LIMIT) {
        const now = Date.now();
        for (const [id, expiresAt] of consumed) if (expiresAt <= now) consumed.delete(id);
        // Still full of live grants: forget the oldest rather than grow without bound.
        const oldest = consumed.keys().next();
        if (consumed.size >= LEDGER_LIMIT && !oldest.done) consumed.delete(oldest.value);
      }
      consumed.set(grant.grant_id, Date.parse(grant.expires_at));
    },
  };
}
