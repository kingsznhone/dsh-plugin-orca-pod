import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";

import type { AckSchema } from "../core/wire/reply.ts";
import {
  HeartbeatRequestSchema,
  JoinRequestSchema,
  type Admission,
  type AdmissionKind,
  type SelfDescription,
} from "../mesh/wire.ts";
import {
  membersDigest,
  normalizeEndpoints,
  runtimeDigest,
  type HeartbeatResponse,
  type JoinResponse,
  type MembersResponse,
  type PeerView,
  type SelfRecord,
  type OrcaNodeId,
} from "../core/wire/peer.ts";
import { DEFAULT_CLOCK_SKEW_MS, type NonceCache } from "../core/signing.ts";
import { verifyAdmission } from "../mesh/admission.ts";
import type { Membership } from "../mesh/membership.ts";
import type { SelfProfile } from "../mesh/self-profile.ts";
import { PodError } from "../core/errors.ts";
import { EXPLICIT_DIAL_POLICY, screenEndpoint } from "../mesh/screening.ts";
import { isDirectLoopbackRequest } from "../core/net.ts";
import type { SingleSlotTaskRunner } from "../task/runner.ts";
import { parseInput } from "./input.ts";

/** The recorded profile of a peer: what it described, with endpoints screened (§7.7). */
type Profile = Pick<
  PeerView,
  | "display_name"
  | "endpoints"
  | "runtime"
  | "runtime_digest"
  | "max_task_ttl_s"
  | "models"
  | "default_model"
  | "default_reasoning_effort"
>;

/** How long a heartbeat may reuse the screening verdict for an unchanged endpoint list. */
const SCREENING_TTL_MS = 60_000;

const ack: z.infer<typeof AckSchema> = { ok: true };

/**
 * The endpoints of a joining node this node is willing to dial back (§7.7).
 * The joiner proved the password, so public addresses are fine, but what it
 * declares is still input: link-local (cloud metadata), multicast and
 * unspecified addresses are dropped, and so are loopback addresses unless the
 * join itself came over loopback (a remote machine cannot be reached at our
 * 127.0.0.1, so such an endpoint could only aim our heartbeats at a local
 * service). Screening happens in exactly two places: here, for join-declared
 * endpoints, and before each dial of a candidate endpoint; the transport itself
 * never screens.
 */
async function dialableEndpoints(declared: string[], request: FastifyRequest): Promise<string[]> {
  const policy = { ...EXPLICIT_DIAL_POLICY, allowLoopbackPeers: isDirectLoopbackRequest(request) };
  // A name that does not resolve from here is kept: it is not known to be bad.
  // It is dialed as-is if it resolves later; only candidates are re-screened.
  const verdicts = await Promise.all(declared.map((endpoint) => screenEndpoint(endpoint, policy)));
  const allowed = declared.filter((_, index) => verdicts[index] !== "refused");
  if (allowed.length === 0) {
    throw new PodError("endpoint_refused", `none of the declared endpoints may be dialed: ${declared.join(", ")}`);
  }
  return allowed;
}

/** Join, heartbeat and the inspection routes of the workgroup (§3, §7.1). */
export class ClusterRoutes {
  /**
   * Last screening per node: heartbeats repeat the same endpoints every few
   * seconds, and screening may resolve names. Join always screens afresh.
   */
  private readonly screened = new Map<string, { key: string; allowed: string[]; atMs: number }>();

  constructor(
    private readonly profile: SelfProfile,
    private readonly membership: Membership,
    private readonly tasks: SingleSlotTaskRunner,
    /** Workgroup key behind the admission proofs (§7.1). */
    private readonly key: Buffer,
    private readonly nonces: NonceCache,
  ) {}

  register(app: FastifyInstance): void {
    app.get("/health", { config: { access: "public" } }, () => this.health());
    app.get("/.well-known/agent-card.json", { config: { access: "public" } }, () => this.agentCard());
    app.post("/cluster/join", { config: { access: "join" } }, (request) => this.join(request));
    app.post("/cluster/heartbeat", { config: { access: "member" } }, (request) => this.heartbeat(request));
    // Inspection for the CLI (`members`, resolving a peer's id): every record this
    // node holds, offline ones included. No node merges it into its own table.
    app.get("/cluster/members", { config: { access: "member" } }, () => this.members());
    app.post("/cluster/leave", { config: { access: "member" } }, (request) => this.leave(request));
  }

  private health() {
    return {
      status: "ok",
      // Public identity hint: a CLI or a first-time caller uses it to bind the
      // target id into the request signature (the id is a public key).
      orca_node_id: this.profile.orcaNodeId,
    };
  }

  private agentCard() {
    const self = this.profile.record();
    const [primary] = self.endpoints;
    return {
      name: self.display_name,
      url: primary ? `${primary}/a2a` : "",
      max_task_ttl_s: self.max_task_ttl_s,
    };
  }

  private async join(request: FastifyRequest): Promise<JoinResponse> {
    const body = parseInput(JoinRequestSchema, request.body, "body");
    this.admit("join", request.auth.orcaNodeId, body);
    this.membership.upsert({
      orca_node_id: body.orca_node_id,
      ...(await this.profileOf(body.orca_node_id, body, request, false)),
      state: "online",
      busy: null,
      last_recv_at: new Date().toISOString(),
    });
    const { self, digest } = this.roster();
    return { self, members: this.membership.list(), members_digest: digest };
  }

  private async heartbeat(request: FastifyRequest): Promise<HeartbeatResponse> {
    const body = parseInput(HeartbeatRequestSchema, request.body, "body");
    const caller = request.auth.orcaNodeId;
    this.admit("heartbeat", caller, body);
    if (!this.membership.observeInbound(caller)) {
      throw new PodError("unknown_orca_node");
    }
    const peer = this.membership.get(caller);
    if (peer !== undefined && (body.self !== undefined || body.busy !== undefined)) {
      // The sender's own signed self-description: how a profile that changed
      // after join (a model catalog that arrived late) reaches its peers (§3.3).
      const profile = body.self === undefined ? {} : await this.profileOf(caller, body.self, request, true);
      this.membership.upsert({ ...peer, ...profile, busy: body.busy === undefined ? peer.busy : body.busy });
    }

    const { members, digest } = this.roster();
    return {
      from: this.profile.orcaNodeId,
      busy: this.tasks.busy(),
      members_digest: digest,
      members: body.digest === digest ? null : members,
    };
  }

  private members(): MembersResponse {
    const members = [...this.membership.list(), this.profile.record()];
    return { members_digest: membersDigest(members), members };
  }

  private leave(request: FastifyRequest): z.infer<typeof AckSchema> {
    this.membership.remove(request.auth.orcaNodeId);
    return ack;
  }

  /**
   * Admission (section 7.1): the Ed25519 signature proved which node is calling;
   * the password-derived proof shows it still holds the workgroup secret.
   * Heartbeats repeat it so a node whose password changed drops out within a few
   * ticks.
   */
  private admit(kind: AdmissionKind, caller: OrcaNodeId, body: Admission): void {
    if (body.workgroup_id !== this.profile.workgroupId) {
      throw new PodError("workgroup_mismatch", "workgroup_id does not match this orca node");
    }
    if (body.orca_node_id !== caller) {
      throw new PodError("bad_request", "orca_node_id does not match the authenticated orca node");
    }
    if (Math.abs(Date.now() - body.ts) > DEFAULT_CLOCK_SKEW_MS) {
      throw new PodError("clock_skew", "admission proof timestamp outside the skew window");
    }
    if (!verifyAdmission(kind, this.key, body)) {
      throw new PodError("bad_proof", "workgroup admission proof does not verify");
    }
    if (!this.nonces.remember(`${kind}:${caller}:${body.nonce}`)) {
      throw new PodError("nonce_replay", "admission nonce already used");
    }
  }

  /**
   * The directory this node hands out in join and heartbeat answers (§3.5): only
   * itself and the members it hears from. A node that went quiet or a candidate
   * it never reached is not passed on, so no one keeps a dead node circulating.
   */
  private roster(): { self: SelfRecord; members: PeerView[]; digest: string } {
    const self = this.profile.record();
    const members = [...this.membership.directory(), self];
    return { self, members, digest: membersDigest(members) };
  }

  private async profileOf(
    caller: OrcaNodeId,
    described: SelfDescription,
    request: FastifyRequest,
    reuseScreening: boolean,
  ): Promise<Profile> {
    const declared = normalizeEndpoints(described.endpoints);
    if (declared === null) throw new PodError("bad_request", "endpoints must be 1-8 distinct http(s) URLs");
    const key = `${isDirectLoopbackRequest(request)}|${declared.join(",")}`;
    const previous = this.screened.get(caller);
    const reusable =
      reuseScreening && previous !== undefined && previous.key === key && Date.now() - previous.atMs < SCREENING_TTL_MS;
    const endpoints = reusable ? previous.allowed : await dialableEndpoints(declared, request);
    if (!reusable) this.screened.set(caller, { key, allowed: endpoints, atMs: Date.now() });
    const runtime = described.runtime ?? null;
    return {
      display_name: described.display_name,
      endpoints,
      runtime,
      runtime_digest: runtimeDigest(runtime),
      max_task_ttl_s: described.max_task_ttl_s,
      models: described.models,
      default_model: described.default_model,
      default_reasoning_effort: described.default_reasoning_effort,
    };
  }
}
