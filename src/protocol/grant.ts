/** Permission requests and grants (§7.11, §7.12). */

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
  /** The permission request this grant allows. */
  request_id: Text,
  issued_at: Text,
  expires_at: Text.refine((value) => !Number.isNaN(Date.parse(value)), "must be a date"),
});
export type Grant = z.infer<typeof GrantSchema>;

export const SignedGrantSchema = GrantSchema.extend({ sig: Text });
export type SignedGrant = z.infer<typeof SignedGrantSchema>;

/**
 * What the origin sends back to a suspended task (§7.11): a signed grant, or a
 * refusal. The sender builds this shape; the receiving task checks the grant
 * with `SignedGrantSchema` before it acts on it.
 */
export type ResumeControl = { grant: SignedGrant } | { permission_denied: true; reason: string };
