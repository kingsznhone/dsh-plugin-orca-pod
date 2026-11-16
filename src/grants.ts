/**
 * Permission grants on the target side (§7.11, §7.12): the two payloads that
 * cross the trust boundary are parsed once here (`parseSignedGrant`,
 * `parseTaskRelay`); `checkGrant` only verifies and never consumes, and the
 * ledger is told separately once a grant has been accepted.
 */

import { verifyGrant } from "./crypto.ts";
import { PodError, type PodErrorCode } from "./errors.ts";
import { isRecord, type PermissionRequest, type SignedGrant, type TaskRelay } from "./protocol.ts";

function need(ok: boolean, code: PodErrorCode, message: string): asserts ok {
  if (!ok) throw new PodError(code, message);
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string, code: PodErrorCode): void {
  for (const key of Object.keys(value)) need(allowed.includes(key), code, `${where}: unknown field "${key}"`);
}

/**
 * The child task a permission request is relayed to: its endpoint, id and the
 * request being escalated. `code` is what a malformed relay is reported as: an
 * escalate call is a bad request, an echo script is a bad echo script.
 */
export function parseTaskRelay(raw: unknown, where = "relay", code: PodErrorCode = "bad_request"): TaskRelay {
  need(isRecord(raw), code, `${where} must be an object`);
  onlyKeys(raw, ["peer", "task_id", "request"], where, code);
  const { peer, task_id: taskId, request } = raw;
  need(isText(peer), code, `${where}.peer must be a non-empty string`);
  need(isText(taskId), code, `${where}.task_id must be a non-empty string`);
  need(isRecord(request), code, `${where}.request must be an object`);
  const at = `${where}.request`;
  onlyKeys(
    request,
    [
      "request_id",
      "task_id",
      "tool",
      "requested",
      "requested_by",
      "via",
      "upstream",
      "origin_request_id",
      "expires_at",
    ],
    at,
    code,
  );
  const { request_id, task_id, tool, requested, requested_by, via, upstream, origin_request_id, expires_at } = request;
  need(
    typeof request_id === "string" &&
      typeof task_id === "string" &&
      typeof tool === "string" &&
      typeof requested_by === "string",
    code,
    `${at} needs string request_id, task_id, tool and requested_by`,
  );
  need(isRecord(requested), code, `${at}.requested must be an object`);
  need(isTextList(via), code, `${at}.via must be a string array`);
  need(upstream === undefined || isTextList(upstream), code, `${at}.upstream must be a string array`);
  need(
    origin_request_id === undefined || typeof origin_request_id === "string",
    code,
    `${at}.origin_request_id must be a string`,
  );
  need(expires_at === undefined || typeof expires_at === "string", code, `${at}.expires_at must be a string`);
  return {
    peer,
    task_id: taskId,
    request: {
      request_id,
      task_id,
      tool,
      requested,
      requested_by,
      via,
      ...(upstream === undefined ? {} : { upstream }),
      ...(origin_request_id === undefined ? {} : { origin_request_id }),
      ...(expires_at === undefined ? {} : { expires_at }),
    },
  };
}

/** A grant as it arrives in a resume message; the signature is checked later, by `checkGrant`. */
export function parseSignedGrant(raw: unknown): SignedGrant {
  const bad = (what: string): never => {
    throw new PodError("bad_request", `grant ${what}`);
  };
  if (!isRecord(raw)) return bad("must be an object");
  const {
    grant_id,
    workgroup_id,
    origin_orca_node,
    task_id,
    target_orca_node,
    tool,
    mode,
    chain,
    request_id,
    issued_at,
    expires_at,
    sig,
  } = raw;
  const texts = {
    grant_id,
    workgroup_id,
    origin_orca_node,
    task_id,
    target_orca_node,
    tool,
    request_id,
    issued_at,
    expires_at,
    sig,
  };
  for (const [name, value] of Object.entries(texts)) if (!isText(value)) bad(`${name} must be a non-empty string`);
  if (mode !== "allow_once") bad('mode must be "allow_once"');
  if (!isTextList(chain) || chain.length === 0) bad("chain must be a non-empty string array");
  if (Number.isNaN(Date.parse(expires_at as string))) bad("expires_at must be a date");
  return {
    grant_id,
    workgroup_id,
    origin_orca_node,
    task_id,
    target_orca_node,
    tool,
    mode,
    chain,
    request_id,
    issued_at,
    expires_at,
    sig,
  } as SignedGrant;
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

/**
 * Returns the failure reason, or null when the grant is genuine and matches what
 * was asked. Pure: accepting the grant (`GrantLedger.consume`) is the caller's step.
 */
export function checkGrant(
  grant: SignedGrant,
  expected: GrantExpectation,
  ledger: GrantLedger,
  now = Date.now(),
): string | null {
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
