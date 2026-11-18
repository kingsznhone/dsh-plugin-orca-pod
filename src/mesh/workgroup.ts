import { PodError } from "../core/errors.ts";
import { EventBus, type NodeLogger } from "../core/events.ts";
import {
  HeartbeatResponseSchema,
  JoinResponseSchema,
  membersDigest,
  type HeartbeatResponse,
  type JoinResponse,
  type OrcaNodeId,
  type PeerView,
} from "../core/wire/peer.ts";
import { AckSchema } from "../core/wire/reply.ts";
import { createAdmission } from "./admission.ts";
import { EndpointDialer } from "./dialer.ts";
import type { Membership } from "./membership.ts";
import type { HttpPeerClient } from "./peer-client.ts";
import type { DialPolicy } from "./screening.ts";
import type { SelfProfile } from "./self-profile.ts";
import type { HeartbeatRequest, JoinRequest, MembersEvent } from "./wire.ts";

/** A 401 proves the peer no longer shares this password (§7.1). */
function isAdmissionRejection(error: unknown): boolean {
  return error instanceof PodError && error.status === 401;
}

/**
 * The response carries no signature of its own, so it must not be able to
 * speak for a node other than the one we dialed (§7.1). First contact is TOFU:
 * with nothing to compare it with, any answer is taken.
 */
function assertAnsweredBy(route: string, peerUrl: string, claimed: OrcaNodeId, expected: OrcaNodeId | undefined): void {
  if (expected !== undefined && claimed !== expected) {
    throw new Error(`${route} from ${peerUrl} claimed ${claimed} but ${expected} was expected`);
  }
}

/** The roster fields a panel renders; two rosters with the same signature need no event. */
function signatureOf(peers: PeerView[]): string {
  return peers
    .map((peer) => {
      const model = peer.default_model ? `${peer.default_model.provider}/${peer.default_model.model}` : "";
      return (
        `${peer.orca_node_id}:${peer.state}:${peer.busy?.task_id ?? ""}:${peer.endpoints.join(",")}` +
        `:${peer.models?.length ?? 0}:${model}:${peer.default_reasoning_effort ?? ""}`
      );
    })
    .sort()
    .join("|");
}

/**
 * This node's side of the workgroup (§3): it admits itself at a peer (`join`),
 * keeps the members' records fresh (`heartbeat`), says goodbye (`leave`) and
 * tells its listeners when the roster changed.
 */
export class Workgroup {
  /** Fires when something a panel would render about the roster changed (§9.2). */
  readonly events: EventBus<MembersEvent>;

  private readonly dialer: EndpointDialer;
  private readonly logger: NodeLogger;
  private membersSignature = "";

  constructor(
    /** Workgroup key behind the admission proofs (§7.1). */
    private readonly key: Buffer,
    private readonly membership: Membership,
    private readonly client: HttpPeerClient,
    private readonly profile: SelfProfile,
    options: { logger: NodeLogger; dial: DialPolicy },
  ) {
    this.logger = options.logger;
    this.events = new EventBus(options.logger);
    this.dialer = new EndpointDialer(membership, options.logger, options.dial);
  }

  /** What this node passes on (§3.5): itself and the members it hears from; its digest is what peers compare. */
  digest(): string {
    return membersDigest([...this.membership.directory(), this.profile.peer()]);
  }

  /** Emit a `members` event if something a panel would render changed (§9.2). */
  emitMembersIfChanged(): void {
    const current = this.roster();
    const signature = signatureOf(current);
    if (signature === this.membersSignature) return;
    this.membersSignature = signature;
    this.events.emit({ type: "members", members: current, digest: membersDigest(current) });
  }

  /** Admit this node at `peerUrl` with the workgroup password; the only call that may reach a stranger. */
  async join(peerUrl: string): Promise<JoinResponse> {
    // A first contact has no receiver id to sign to; a known URL must keep answering as the same node.
    const expected = this.client.idOf(peerUrl);
    const request: JoinRequest = { ...this.admission("join"), ...this.profile.description() };
    const response = await this.client.call(
      peerUrl,
      { method: "POST", path: "/cluster/join", payload: request, reply: JoinResponseSchema },
      { target: expected ?? "" },
    );
    assertAnsweredBy("/cluster/join", peerUrl, response.self.orca_node_id, expected);
    this.membership.upsert(response.self);
    this.client.learn(peerUrl, response.self.orca_node_id);
    this.membership.observeInbound(response.self.orca_node_id);
    this.membership.mergeRemote(response.members);
    this.emitMembersIfChanged();
    return response;
  }

  /**
   * Join every member of a directory response, best-effort: one unreachable
   * member must not stop this node from joining the rest of the mesh (§3.2).
   * A member is tried at each of its advertised URLs in turn (IPv6 unreachable,
   * LAN vs public…).
   */
  async joinAll(members: readonly PeerView[]): Promise<{ joined: OrcaNodeId[]; failed: OrcaNodeId[] }> {
    const joined: OrcaNodeId[] = [];
    const failed: OrcaNodeId[] = [];
    for (const member of members) {
      if (member.orca_node_id === this.profile.orcaNodeId || member.endpoints.length === 0) continue;
      ((await this.joinAt(member)) ? joined : failed).push(member.orca_node_id);
    }
    return { joined, failed };
  }

  /** One heartbeat to a URL the node already knows. */
  async heartbeat(peerUrl: string): Promise<HeartbeatResponse> {
    const targetId = this.client.known(peerUrl);
    try {
      return await this.pulse(peerUrl, targetId);
    } catch (error) {
      if (!isAdmissionRejection(error)) this.membership.observeOutboundFail(targetId);
      throw error;
    }
  }

  /**
   * Heartbeat one peer by trying its advertised URLs in order (IPv4/IPv6, LAN,
   * public): a single unreachable URL must not mark the peer offline (§7.7).
   */
  async heartbeatPeer(peer: PeerView): Promise<void> {
    for (const endpoint of await this.dialer.dialOrder(peer)) {
      try {
        await this.pulse(endpoint, peer.orca_node_id);
        this.dialer.prefer(peer.orca_node_id, endpoint);
        return;
      } catch (error) {
        // Every URL belongs to the same node, so a credential mismatch is final.
        if (isAdmissionRejection(error)) return;
      }
    }
    this.membership.observeOutboundFail(peer.orca_node_id);
  }

  /** URLs a member can be dialed at, screened, the last one that worked first; empty for a non-member. */
  async endpointsOf(nodeId: OrcaNodeId): Promise<string[]> {
    const peer = this.membership.get(nodeId);
    return peer === undefined ? [] : this.dialer.dialOrder(peer);
  }

  /** Leave the workgroup (§9.2): tell each peer, best effort, then clear the roster; resolves to the peers that answered and so know this node is gone. */
  async leave(): Promise<{ left: OrcaNodeId[] }> {
    const left: OrcaNodeId[] = [];
    for (const peer of this.membership.list()) {
      if (await this.notifyLeave(peer)) left.push(peer.orca_node_id);
      this.forgetPeer(peer.orca_node_id);
    }
    this.emitMembersIfChanged();
    return { left };
  }

  /** Join one member at the first of its advertised URLs that answers. */
  private async joinAt(member: PeerView): Promise<boolean> {
    for (const endpoint of member.endpoints) {
      try {
        await this.join(endpoint);
        return true;
      } catch {
        // Try the member's next advertised URL.
      }
    }
    return false;
  }

  /** Every member this node knows, for its own panel and events. */
  private roster(): PeerView[] {
    return [...this.membership.list(), this.profile.peer()];
  }

  private admission(kind: "join" | "heartbeat") {
    return createAdmission(kind, this.key, {
      workgroupId: this.profile.workgroupId,
      orcaNodeId: this.profile.orcaNodeId,
    });
  }

  private sendHeartbeat(peerUrl: string, targetId: OrcaNodeId): Promise<HeartbeatResponse> {
    const request: HeartbeatRequest = {
      ...this.admission("heartbeat"),
      busy: this.profile.busy,
      digest: this.digest(),
      self: this.profile.description(),
    };
    return this.client.call(
      peerUrl,
      { method: "POST", path: "/cluster/heartbeat", payload: request, reply: HeartbeatResponseSchema },
      { target: targetId, timeoutMs: this.membership.timings.heartbeatTimeoutMs },
    );
  }

  /**
   * One heartbeat. The peer pruned our record (404) or no longer lists us as a
   * member (403): join once so it re-admits us, then send again. A real password
   * mismatch makes that join fail with 401, which the caller turns into a drop (§7.1).
   */
  private async heartbeatWithRejoin(peerUrl: string, targetId: OrcaNodeId): Promise<HeartbeatResponse> {
    try {
      return await this.sendHeartbeat(peerUrl, targetId);
    } catch (error) {
      if (!(error instanceof PodError && (error.status === 404 || error.code === "not_a_member"))) throw error;
      await this.join(peerUrl);
      return this.sendHeartbeat(peerUrl, targetId);
    }
  }

  /** One heartbeat to one URL; counting a failure is the caller's call, once per peer rather than once per URL. */
  private async pulse(peerUrl: string, targetId: OrcaNodeId): Promise<HeartbeatResponse> {
    try {
      const response = await this.heartbeatWithRejoin(peerUrl, targetId);
      assertAnsweredBy("/cluster/heartbeat", peerUrl, response.from, targetId);
      this.membership.observeInbound(response.from);
      this.membership.observeOutboundOk(response.from);
      if (response.members) this.membership.mergeRemote(response.members);
      this.emitMembersIfChanged();
      return response;
    } catch (error) {
      if (isAdmissionRejection(error)) {
        // This peer still uses another password: stop answering it and forget the
        // record (§7.1). Its own heartbeats to us fail identically, so the whole
        // old mesh drops the changed node instead of keeping it "online" forever.
        this.dropPeer(targetId, "workgroup admission rejected");
      }
      throw error;
    }
  }

  /** Forget everything this node holds about a peer. */
  private forgetPeer(nodeId: OrcaNodeId): void {
    this.membership.remove(nodeId);
    this.dialer.forget(nodeId);
    this.client.forget(nodeId);
  }

  /** Drop a node that failed admission: it is not part of this mesh anymore. */
  private dropPeer(nodeId: OrcaNodeId, reason: string): void {
    if (this.membership.get(nodeId) !== undefined) {
      this.logger.warn(`orca-pod: dropping node ${nodeId} (${reason}, §7.1)`);
    }
    this.forgetPeer(nodeId);
    this.emitMembersIfChanged();
  }

  /** Tell one peer we are leaving; true when it acknowledged. A peer that is already gone must not keep us from leaving. */
  private async notifyLeave(peer: PeerView): Promise<boolean> {
    const [endpoint] = peer.endpoints;
    if (endpoint === undefined) return false;
    try {
      await this.client.call(
        endpoint,
        { method: "POST", path: "/cluster/leave", reply: AckSchema },
        { target: peer.orca_node_id },
      );
      return true;
    } catch {
      return false;
    }
  }
}
