/**
 * Permission grants on the target side (§7.11, §7.12): the two payloads that
 * cross the trust boundary are parsed once here (`parseSignedGrant`,
 * `parseTaskRelay`); `checkGrant` only verifies and never consumes, and the
 * ledger is told separately once a grant has been accepted.
 */

import { verifyGrant } from "./crypto.ts";
import { PodError, type PodErrorCode } from "../kernel/errors.ts";
import { describeIssue, parseSchema } from "../kernel/schema.ts";
import {
  SignedGrantSchema,
  TaskRelaySchema,
  type PermissionRequest,
  type SignedGrant,
  type TaskRelay,
} from "../protocol/grant.ts";

/**
 * The child task a permission request is relayed to: its endpoint, id and the
 * request being escalated. `code` is what a malformed relay is reported as: an
 * escalate call is a bad request, an echo script is a bad echo script.
 */
export function parseTaskRelay(raw: unknown, where = "relay", code: PodErrorCode = "bad_request"): TaskRelay {
  const parsed = parseSchema(TaskRelaySchema, raw);
  if (parsed.ok) return parsed.value;
  const { path, message } = parsed.issue;
  throw new PodError(code, `${[where, ...path].join(".")} ${message}`);
}

/** A grant as it arrives in a resume message; the signature is checked later, by `checkGrant`. */
export function parseSignedGrant(raw: unknown): SignedGrant {
  const parsed = parseSchema(SignedGrantSchema, raw);
  if (parsed.ok) return parsed.value;
  throw new PodError("bad_request", `grant ${describeIssue(parsed.issue)}`);
}

/** What a grant has to match: the task that waits and the request it is parked on. */
export type GrantExpectation = {
  taskId: string;
  selfOrcaNodeId: string;
  workgroupId: string;
  /** Origin of the whole delegation tree: the only node whose decision counts (§7.11). */
  rootOrigin: string;
  /** Delegation chain of this task, origin first. */
  chain: string[];
  pending: PermissionRequest;
};

/** Why a grant is not accepted; each is also the `PodErrorCode` the task fails with. */
export type GrantFailure = "grant_invalid" | "grant_expired" | "grant_replayed";

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
  // The deciding origin must be the root of this delegation tree and the first
  // hop it signed. Anything else means the grant was re-labelled (§7.11).
  if (grant.chain[0] !== grant.origin_orca_node) return "grant_invalid";
  if (grant.origin_orca_node !== expected.rootOrigin) return "grant_invalid";
  if (grant.workgroup_id !== expected.workgroupId) return "grant_invalid";
  if (grant.tool !== expected.pending.tool) return "grant_invalid";
  if (Date.parse(grant.expires_at) <= now) return "grant_expired";
  // The grant allows exactly one leaf request; relaying reuses the leaf id, so
  // an intermediate hop cannot redirect the human's decision (§7.12).
  if (grant.request_id !== (expected.pending.origin_request_id ?? expected.pending.request_id)) return "grant_invalid";
  if (ledger.has(grant.grant_id, now)) return "grant_replayed";
  // Direct decision: the origin signed this very task for this very node.
  if (grant.task_id === expected.taskId && grant.target_orca_node === expected.selfOrcaNodeId) return null;
  // Delegated decision (§7.12): the origin signed for an ancestor of this
  // task's delegation chain; middle nodes forward that grant unchanged.
  const delegated =
    grant.target_orca_node !== expected.selfOrcaNodeId &&
    expected.chain.includes(grant.target_orca_node) &&
    grant.chain.slice(1).every((hop, index) => expected.chain[index] === hop);
  return delegated ? null : "grant_invalid";
}

const LEDGER_LIMIT = 1024;

/**
 * A grant is `allow_once`: remembering its id until it expires turns a replay
 * into `grant_replayed` instead of a second allowed tool call (§7.11).
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

/** Why a child grant cannot be derived from this parent. */
type CoverFailure = "escalation_required" | "grant_expired";

/** Why a child grant cannot be derived from this parent, or null when it can. */
export function grantCovers(
  parent: SignedGrant,
  request: Pick<PermissionRequest, "tool">,
  nowMs = Date.now(),
): CoverFailure | null {
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
