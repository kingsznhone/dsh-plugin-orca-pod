/** The node table on the wire (§3): the records peers list, and the `hello` every contact between two nodes is made of (§3.3). */

import { createHash } from "node:crypto";

import { z } from "zod";

import { OrcaNodeIdSchema, WorkgroupIdSchema } from "../core/ids.ts";
import { ModelOffersSchema, ModelSelectionSchema, ReasoningEffortSchema } from "../executor/model.ts";
import { BusyStateSchema } from "../task/wire.ts";

// ---- the records of the node table (§3) ----

const PeerStateSchema = z.enum(["unknown", "online", "suspect", "offline"]);
export type PeerState = z.infer<typeof PeerStateSchema>;

/** Host facts a node advertises in its hello (§3.3); `runtime_digest` covers them. */
export const RuntimeInfoSchema = z.object({
  os: z.object({ family: z.string(), name: z.string(), version: z.string() }),
  arch: z.string(),
  cpu: z.object({ model: z.string(), logical_cores: z.number().int() }),
  memory: z.object({ total_bytes: z.number() }),
  node: z.object({ version: z.string() }),
  captured_at: z.string(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

export const PeerViewSchema = z.object({
  orca_node_id: OrcaNodeIdSchema,
  display_name: z.string(),
  /** Base URLs peers may dial, best first; one entry is the common case (§3.2). */
  endpoints: z.array(z.string()),
  runtime: RuntimeInfoSchema.nullable(),
  runtime_digest: z.string(),
  state: PeerStateSchema,
  busy: BusyStateSchema.nullable(),
  last_recv_at: z.string().nullable(),
  /** Per-task time budget this orca node enforces; origins size tasks to it (§6.9). */
  max_task_ttl_s: z.number().positive().optional(),
  /** Model routes this orca node can switch an ACP session to (§6.15). */
  models: ModelOffersSchema.optional(),
  /** The model an ACP session uses when a task does not name one (§6.15). */
  default_model: ModelSelectionSchema.nullable().optional(),
  /** Reasoning effort an ACP session uses when a task does not name one (§6.15). */
  default_reasoning_effort: ReasoningEffortSchema.nullable().optional(),
});
export type PeerView = z.infer<typeof PeerViewSchema>;

const SelfRecordSchema = PeerViewSchema.extend({ workgroup_id: WorkgroupIdSchema });
export type SelfRecord = z.infer<typeof SelfRecordSchema>;

/**
 * The answer to a `hello` (§3.3): the answering node's own record and the digest
 * of the directory it vouches for. `members` is that directory, sent only when
 * the caller's digest differs; they are candidates for the caller, never a claim
 * that anyone is online.
 */
export const HelloResponseSchema = z.object({
  self: SelfRecordSchema,
  members_digest: z.string(),
  members: z.array(PeerViewSchema).nullable(),
});
export type HelloResponse = z.infer<typeof HelloResponseSchema>;

const MembersResponseSchema = z.object({ members_digest: z.string(), members: z.array(PeerViewSchema) });
export type MembersResponse = z.infer<typeof MembersResponseSchema>;

export function runtimeDigest(runtime: RuntimeInfo | null): string {
  if (!runtime) return "none";
  const stable = [
    runtime.os.family,
    runtime.os.name,
    runtime.os.version,
    runtime.arch,
    runtime.cpu.model,
    String(runtime.cpu.logical_cores),
    String(runtime.memory.total_bytes),
    runtime.node.version,
  ].join("|");
  return createHash("sha256").update(stable).digest("hex");
}

export function membersDigest(peers: readonly PeerView[]): string {
  const lines = peers.map((peer) => `${peer.orca_node_id}|${peer.endpoints.join(",")}|${peer.runtime_digest}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

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
