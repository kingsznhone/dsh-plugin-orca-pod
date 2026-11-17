/**
 * Every stable error code this node emits, with the HTTP status it maps to.
 * One table: a code cannot exist without a status, and `PodErrorCode` is derived
 * from it, so a thrown code that is not listed here does not compile.
 */
export const POD_ERROR_STATUS = {
  // Request authentication (§7.1).
  missing_auth: 401,
  malformed_auth: 401,
  clock_skew: 401,
  nonce_replay: 401,
  bad_signature: 401,
  wrong_target: 401,
  stale_request: 401,
  bad_proof: 401,
  // Authorization.
  not_a_member: 403,
  local_only: 403,
  link_invalid: 403,
  not_task_origin: 403,
  ancestor_call_forbidden: 403,
  // Malformed or unsupported requests.
  bad_request: 400,
  bad_echo_script: 400,
  unsupported: 400,
  workgroup_mismatch: 400,
  /** A join whose declared endpoints are all forbidden by the screening policy (§7.7). */
  endpoint_refused: 400,
  // Unknown resources.
  task_not_found: 404,
  blob_not_found: 404,
  unknown_orca_node: 404,
  // State conflicts.
  permission_denied: 409,
  grant_invalid: 409,
  grant_expired: 409,
  escalation_required: 409,
  // Gone.
  link_expired: 410,
  blob_expired: 410,
  blob_file_missing: 410,
  // Limits.
  body_too_large: 413,
  orca_node_busy: 429,
  quota_exceeded: 507,
  internal: 500,
  // Outbound calls (see transport/peer-client.ts): raised on this node, never sent over the wire.
  unknown_peer: 404,
  peer_not_online: 503,
  peer_error: 502,
} as const satisfies Record<string, number>;

export type PodErrorCode = keyof typeof POD_ERROR_STATUS;

/**
 * The one error type of this node: the gateway turns it into an HTTP response
 * (see transport/gateway/error-handler.ts), and the peer client raises it for a failed
 * outbound call, with the status the peer answered with.
 */
export class PodError extends Error {
  readonly code: PodErrorCode;
  readonly status: number;

  constructor(code: PodErrorCode, message: string = code, status: number = POD_ERROR_STATUS[code]) {
    super(message);
    this.name = "PodError";
    this.code = code;
    this.status = status;
  }
}

export function isPodErrorCode(value: unknown): value is PodErrorCode {
  return typeof value === "string" && Object.hasOwn(POD_ERROR_STATUS, value);
}

/** Compile-time proof that a `switch` handled every variant. */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}

/** A printable message for an arbitrary thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
