/** Join and heartbeat on the wire (§3.3, §7.1): the request bodies both sides share. */

import { z } from "zod";

import { BusyStateSchema, OrcaNodeIdSchema, PeerViewSchema, RuntimeInfoSchema, WorkgroupIdSchema } from "./peer.ts";

/** Entry to the mesh (`join`) and the proof repeated on every beat (`heartbeat`) are signed under different domains (§7.1). */
export const AdmissionKindSchema = z.enum(["join", "heartbeat"]);
export type AdmissionKind = z.infer<typeof AdmissionKindSchema>;

/** Fields every admission (join, heartbeat) carries (§7.1). */
export const AdmissionSchema = z.object({
  workgroup_id: WorkgroupIdSchema,
  orca_node_id: OrcaNodeIdSchema,
  ts: z.number().int(),
  nonce: z.string(),
  proof: z.string(),
});
export type Admission = z.infer<typeof AdmissionSchema>;

/**
 * A node's description of itself (§2.5, §3.3). Join carries it at the top
 * level, a heartbeat as `self`; both are covered by the sender's request
 * signature, so only the node itself can state it. The latest one replaces
 * what the receiver recorded before.
 */
export const SelfDescriptionSchema = PeerViewSchema.pick({
  display_name: true,
  endpoints: true,
  max_task_ttl_s: true,
  models: true,
  default_model: true,
  default_reasoning_effort: true,
}).extend({ runtime: RuntimeInfoSchema.nullable().optional() });
export type SelfDescription = z.infer<typeof SelfDescriptionSchema>;

export const JoinRequestSchema = AdmissionSchema.extend(SelfDescriptionSchema.shape);
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

export const HeartbeatRequestSchema = AdmissionSchema.extend({
  /** The sender's members digest; the answer carries the roster only when it differs. */
  digest: z.string().optional(),
  busy: BusyStateSchema.nullable().optional(),
  /** Optional so a node that predates it still heartbeats; current nodes always send it. */
  self: SelfDescriptionSchema.optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;
