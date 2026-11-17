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
  /**
   * The leaf request this one relays upwards. A grant binds this id because the
   * origin must allow *that* request, not the intermediate hop's copy (§7.12).
   */
  origin_request_id?: string;
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
  /** Decision path: origin first, then the nodes the request passed through. */
  chain: string[];
  /** The leaf permission request this grant allows (§7.12). */
  request_id: string;
  issued_at: string;
  expires_at: string;
};

export type SignedGrant = Grant & { sig: string };

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
