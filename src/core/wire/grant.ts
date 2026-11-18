/** Permission requests and grants (§7.11, §7.12). */

import { z } from "zod";

import { OrcaNodeIdSchema, WorkgroupIdSchema } from "./peer.ts";
import { SandboxModeSchema } from "./permission.ts";

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
 * A suspended task's ask to run with a wider permission mode (§7.11, §7.12):
 * one tool call needed more than `current_mode` allows, and `requested_mode` is
 * the narrowest mode that covers it. It lives in `status.message`, so the origin
 * discovers it by reading task state; nothing is pushed to it.
 */
export const PermissionRequestSchema = z.object({
  request_id: z.string(),
  task_id: z.string(),
  tool: z.string(),
  requested: RequestedAccessSchema,
  /** Orca node that needs the permission (the one running the task). */
  requested_by: OrcaNodeIdSchema,
  /** The task's effective mode when it stopped. */
  current_mode: SandboxModeSchema,
  /** The mode the task asks to continue with, wider than `current_mode` and within the target's ceiling. */
  requested_mode: SandboxModeSchema,
  /** Present only when the executing orca node configures an approval timeout (§7.12). */
  expires_at: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

/**
 * A human decision travelling from the origin back down to the target (§7.11):
 * the task may continue with `permission_mode` until it ends. Signed by the
 * origin node's Ed25519 key: the transport is already authenticated, but a
 * grant is also the durable record of who allowed what.
 */
export const GrantSchema = z.object({
  grant_id: Text,
  workgroup_id: WorkgroupIdSchema,
  /** Orca node whose signature authorizes this grant (the deciding origin). */
  origin_orca_node: OrcaNodeIdSchema,
  task_id: Text,
  target_orca_node: OrcaNodeIdSchema,
  tool: Text,
  /** The mode the task runs with from now on; it is the request's `requested_mode`. */
  permission_mode: SandboxModeSchema,
  /** The permission request this grant answers. */
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
