/** The `hello` on the wire (§3.3): the one request every contact between two nodes is made of. */

import { z } from "zod";

import { BusyStateSchema, PeerViewSchema, RuntimeInfoSchema, type PeerView } from "../core/wire/peer.ts";

/**
 * A node's description of itself (§2.5, §3.3). It rides in every `hello`, covered
 * by the sender's request signature, so only the node itself can state it; the
 * latest one replaces what the receiver recorded before.
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

/**
 * Who the sender is and what it knows. There is no admission in the body: that
 * the sender is in the workgroup was proved in the request header (§3.3). A first
 * contact and a heartbeat are the same request, except that a first contact has
 * no digest to compare and no receiver id to sign to.
 */
export const HelloRequestSchema = z.object({
  self: SelfDescriptionSchema,
  busy: BusyStateSchema.nullable(),
  /** The sender's members digest; the answer carries the directory only when it differs. */
  digest: z.string(),
});
export type HelloRequest = z.infer<typeof HelloRequestSchema>;

/** The member list changed (§9.2). */
export type MembersEvent = { type: "members"; members: PeerView[]; digest: string };
