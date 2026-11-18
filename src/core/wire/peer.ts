/** Peers and the member directory on the wire (§3, §4). */

import { createHash } from "node:crypto";
import { z } from "zod";

import { brandString, type Branded } from "@deepseek-ai/dsh-brand";

import { ModelOffersSchema, ModelSelectionSchema, ReasoningEffortSchema } from "./model.ts";

/**
 * An orca node id is the base64url-encoded raw Ed25519 public key (§7.1), so a
 * valid id is self-certifying: whoever signs with the matching private key owns
 * the id, and no shared workgroup secret can stand in for it. 43 characters
 * always decode to exactly 32 bytes. A checked id is only made by
 * `OrcaNodeIdSchema` (or `isOrcaNodeId`) from a plain string.
 */
export type OrcaNodeId = Branded<"OrcaNodeId">;

export const OrcaNodeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "must be an Ed25519 public key (43 base64url chars)")
  .transform((id) => brandString<OrcaNodeId>(id));

export function isOrcaNodeId(value: unknown): value is OrcaNodeId {
  return OrcaNodeIdSchema.safeParse(value).success;
}

/** A checked workgroup id; only `WorkgroupIdSchema` (or `isWorkgroupId`) makes one from a plain string. */
export type WorkgroupId = Branded<"WorkgroupId">;

export const WorkgroupIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,31}$/, "must match [a-z0-9][a-z0-9-]{1,31}")
  .transform((id) => brandString<WorkgroupId>(id));

export function isWorkgroupId(value: unknown): value is WorkgroupId {
  return WorkgroupIdSchema.safeParse(value).success;
}

export const PeerStateSchema = z.enum(["unknown", "online", "suspect", "offline"]);
export type PeerState = z.infer<typeof PeerStateSchema>;

/** Host facts a node advertises at join (§3.3); `runtime_digest` covers them. */
export const RuntimeInfoSchema = z.object({
  os: z.object({ family: z.string(), name: z.string(), version: z.string() }),
  arch: z.string(),
  cpu: z.object({ model: z.string(), logical_cores: z.number().int() }),
  memory: z.object({ total_bytes: z.number() }),
  node: z.object({ version: z.string() }),
  captured_at: z.string(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

/** The task holding a node's single slot (§6.9). */
export const BusyStateSchema = z.object({
  task_id: z.string(),
  origin_orca_node: OrcaNodeIdSchema,
  since: z.string(),
});
export type BusyState = z.infer<typeof BusyStateSchema>;

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

export const SelfRecordSchema = PeerViewSchema.extend({ workgroup_id: WorkgroupIdSchema });
export type SelfRecord = z.infer<typeof SelfRecordSchema>;

export const JoinResponseSchema = z.object({
  self: SelfRecordSchema,
  members: z.array(PeerViewSchema),
  members_digest: z.string(),
});
export type JoinResponse = z.infer<typeof JoinResponseSchema>;

export const HeartbeatResponseSchema = z.object({
  from: OrcaNodeIdSchema,
  busy: BusyStateSchema.nullable(),
  members_digest: z.string(),
  /** 仅当请求摘要与本地不一致时返回；只是候选端点，不声明在线。 */
  members: z.array(PeerViewSchema).nullable(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

export const MembersResponseSchema = z.object({ members_digest: z.string(), members: z.array(PeerViewSchema) });
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

export function membersDigest(
  peers: ReadonlyArray<Pick<PeerView, "orca_node_id" | "endpoints" | "runtime_digest">>,
): string {
  const lines = peers.map((peer) => `${peer.orca_node_id}|${peer.endpoints.join(",")}|${peer.runtime_digest}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function isHttpEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Max advertised base URLs per orca node; enough for IPv4/IPv6/LAN/public. */
const MAX_ENDPOINTS = 8;

/**
 * Validate and normalize an advertised endpoint list: http(s) base URLs with no
 * trailing slash, deduplicated, order preserved (first is preferred).
 */
export function normalizeEndpoints(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENDPOINTS) return null;
  const endpoints: string[] = [];
  for (const item of value) {
    if (!isHttpEndpoint(item)) return null;
    const endpoint = item.endsWith("/") ? item.slice(0, -1) : item;
    if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  return endpoints.length > 0 ? endpoints : null;
}
