/** Permission requests, grants and relays (§7.11, §7.12). */

import { z } from "zod";

import { OrcaNodeIdSchema, WorkgroupIdSchema } from "./peer.ts";

const Text = z.string().min(1, "must be a non-empty string");

/**
 * What a permission request asks to do: the ACP tool call and its kind, when
 * the executor knows them, plus whatever else the executor describes.
 */
export const RequestedAccessSchema = z.looseObject({
  tool_call_id: z.string().optional(),
  tool_kind: z.string().optional(),
});
export type RequestedAccess = z.infer<typeof RequestedAccessSchema>;

/**
 * A suspended task's ask for one tool outside the origin's grant (§7.11,
 * §7.12). It lives in `status.message`, so the origin discovers it by reading
 * task state; nothing is pushed to it.
 */
export const PermissionRequestSchema = z.object({
  request_id: z.string(),
  task_id: z.string(),
  tool: z.string(),
  requested: RequestedAccessSchema,
  /** Orca node that needs the permission (the one running the task). */
  requested_by: OrcaNodeIdSchema,
  /** Chain from this orca node up to the origin that can decide. */
  via: z.array(OrcaNodeIdSchema),
  /** Orca nodes further down the chain that actually need the permission (§7.12 relay). */
  upstream: z.array(OrcaNodeIdSchema).optional(),
  /**
   * The leaf request this one relays upwards. A grant binds this id because the
   * origin must allow *that* request, not the intermediate hop's copy (§7.12).
   */
  origin_request_id: z.string().optional(),
  /** Present only when the executing orca node configures an approval timeout (§7.12). */
  expires_at: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

/**
 * A human decision travelling from the origin back down to the target (§7.11).
 * Signed by the origin node's Ed25519 key: the transport is already
 * authenticated, but a grant is also the durable record of who allowed what.
 */
export const GrantModeSchema = z.literal("allow_once");
export type GrantMode = z.infer<typeof GrantModeSchema>;

export const GrantSchema = z.object({
  grant_id: Text,
  workgroup_id: WorkgroupIdSchema,
  /** Orca node whose signature authorizes this grant (the deciding origin). */
  origin_orca_node: OrcaNodeIdSchema,
  task_id: Text,
  target_orca_node: OrcaNodeIdSchema,
  tool: Text,
  mode: GrantModeSchema,
  /** Decision path: origin first, then the nodes the request passed through. */
  chain: z.array(OrcaNodeIdSchema).min(1, "must be a non-empty array of orca node ids"),
  /** The leaf permission request this grant allows (§7.12). */
  request_id: Text,
  issued_at: Text,
  expires_at: Text.refine((value) => !Number.isNaN(Date.parse(value)), "must be a date"),
});
export type Grant = z.infer<typeof GrantSchema>;

export const SignedGrantSchema = GrantSchema.extend({ sig: Text });
export type SignedGrant = z.infer<typeof SignedGrantSchema>;

/**
 * A child task an orca node is waiting on while it escalates upward (§7.12).
 * The parent task holds this so an approval can be turned into a child grant.
 * Unknown fields are rejected: a relay is stored and later acted on.
 */
export const TaskRelaySchema = z.strictObject({
  /** Endpoint of the orca node running the child task. */
  peer: Text,
  /** Child task id on that orca node. */
  task_id: Text,
  /** The child's permission request being escalated. */
  request: z.strictObject(PermissionRequestSchema.shape),
});
export type TaskRelay = z.infer<typeof TaskRelaySchema>;

/**
 * What the origin sends back to a suspended task (§7.11): a signed grant, or a
 * refusal. The sender builds this shape; the receiving task checks the grant
 * with `SignedGrantSchema` before it acts on it.
 */
export type ResumeControl = { grant: SignedGrant } | { permission_denied: true; reason: string };
