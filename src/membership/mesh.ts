import { createAdmission } from "../security/crypto.ts";
import { PodError } from "../kernel/errors.ts";
import type { NodeLogger } from "../kernel/events.ts";
import { heartbeatIntervalMsFor, type Membership } from "./membership.ts";
import {
  HeartbeatResponseSchema,
  JoinResponseSchema,
  membersDigest as computeMembersDigest,
  runtimeDigest,
  type BusyState,
  type HeartbeatResponse,
  type JoinResponse,
  type OrcaNodeId,
  type PeerView,
  type RuntimeInfo,
  type SelfRecord,
  type WorkgroupId,
} from "../protocol/peer.ts";
import { AckSchema } from "../protocol/a2a.ts";
import type { HeartbeatRequest, JoinRequest, SelfDescription } from "../protocol/cluster.ts";
import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ModelDefaults, ModelOffer } from "../protocol/model.ts";
import type { PeerClient } from "../protocol/client.ts";
import type { PodEventInput } from "../protocol/events.ts";
import { candidateEndpointAllowed } from "./screening.ts";

/** The part of the node config a workgroup reads: who this node is and what it may dial or advertise. */
export type WorkgroupConfig = {
  orca_node_id: OrcaNodeId;
  workgroup_id: WorkgroupId;
  display_name: string;
  /** A model catalog pinned in config.json; it wins over what the host reports (§6.15). */
  models?: ModelOffer[];
  default_model?: ModelSelection;
  default_reasoning_effort?: ReasoningEffortId;
  allow_public_peers?: boolean;
  allow_loopback_peers?: boolean;
};

/** Which peers answered a `leave` and so know this node is gone. */
export type LeaveResult = { left: OrcaNodeId[] };

type WorkgroupDeps = {
  config: WorkgroupConfig;
  /** Workgroup key behind the admission proofs (§7.1). */
  key: Buffer;
  runtime: RuntimeInfo;
  /** Advertised per-task budget (§6.9). */
  maxTaskTtlS: number;
  membership: Membership;
  client: PeerClient;
  logger: NodeLogger;
  /** Advertised dial URLs; they change once the listener is bound. */
  endpoints: () => string[];
  busy: () => BusyState | null;
  emit: (event: PodEventInput) => void;
  /** Pinned timings keep their heartbeat period; otherwise it follows the mesh size (§3.3). */
  adaptiveHeartbeat: boolean;
};

export type Workgroup = {
  self(): SelfRecord;
  members(): PeerView[];
  membersDigest(): string;
  /** Model routes and default advertised to peers (§6.15); a pin in config.json wins. */
  setModelCatalog(
    models: ModelOffer[],
    defaultModel: ModelSelection | null,
    reasoningEffort?: ReasoningEffortId | null,
  ): void;
  /** What a local ACP session uses when a task names no model. */
  modelDefaults(): ModelDefaults;
  /** Admit this node at `peerUrl` with the workgroup password; the only call that may reach a stranger. */
  join(peerUrl: string): Promise<JoinResponse>;
  heartbeat(peerUrl: string): Promise<HeartbeatResponse>;
  /** URLs a member can be dialed at, screened, the last one that worked first; empty for a non-member. */
  endpointsOf(nodeId: OrcaNodeId): Promise<string[]>;
  leave(): Promise<LeaveResult>;
  /** Emit a `members` event if something a panel would render changed (§9.2). */
  emitMembersIfChanged(): void;
  /** Begin the heartbeat loop. */
  start(): void;
  stop(): void;
};

/** A 401 proves the peer no longer shares this password (§7.1). */
function isAdmissionRejection(error: unknown): boolean {
  return error instanceof PodError && error.status === 401;
}

/** How long one candidate-endpoint screening verdict is reused (§7.7). */
const VERDICT_TTL_MS = 60_000;

export function createWorkgroup(deps: WorkgroupDeps): Workgroup {
  const { config, membership, client, logger } = deps;
  const selfId = config.orca_node_id;
  const ids = { workgroupId: config.workgroup_id, orcaNodeId: selfId };

  // ---- self record and model catalog ----

  let modelCatalog: ModelOffer[] = [...(config.models ?? [])];
  // A local pin in config.json wins over whatever the DSH host reports, which
  // keeps per-node defaults reproducible across UI changes (§6.15).
  const pinnedModel = config.default_model ?? null;
  const pinnedEffort = config.default_reasoning_effort ?? config.default_model?.reasoningEffort ?? null;
  let defaultModel: ModelSelection | null = pinnedModel;
  let defaultEffort: ReasoningEffortId | null = pinnedEffort;

  function setModelCatalog(
    models: ModelOffer[],
    nextDefault: ModelSelection | null,
    nextEffort?: ReasoningEffortId | null,
  ): void {
    const routeOf = (offer: ModelOffer): string => `${offer.provider}/${offer.id}`;
    modelCatalog = models.filter(
      (offer, index) => models.findIndex((other) => routeOf(other) === routeOf(offer)) === index,
    );
    defaultEffort = pinnedEffort ?? nextEffort ?? nextDefault?.reasoningEffort ?? null;
    const fallback = pinnedModel ?? nextDefault;
    defaultModel =
      fallback !== null && defaultEffort !== null ? { ...fallback, reasoningEffort: defaultEffort } : fallback;
    emitMembersIfChanged();
  }

  function selfPeer(): PeerView {
    return {
      orca_node_id: selfId,
      // A fresh node with no display name shows its generated id (§9.2 wizard default).
      display_name: config.display_name.length > 0 ? config.display_name : selfId,
      endpoints: deps.endpoints(),
      runtime: deps.runtime,
      runtime_digest: runtimeDigest(deps.runtime),
      state: "online",
      busy: deps.busy(),
      last_recv_at: new Date().toISOString(),
      max_task_ttl_s: deps.maxTaskTtlS,
      models: modelCatalog.length > 0 ? modelCatalog : undefined,
      default_model: defaultModel,
      default_reasoning_effort: defaultEffort,
    };
  }

  function roster(): PeerView[] {
    return [...membership.list(), selfPeer()];
  }

  const digest = (): string => computeMembersDigest(roster());

  // ---- change events ----

  /** The roster fields a panel renders; two rosters with the same signature need no event. */
  let membersSignature = "";
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

  function emitMembersIfChanged(): void {
    const current = roster();
    const signature = signatureOf(current);
    if (signature === membersSignature) return;
    membersSignature = signature;
    deps.emit({ type: "members", members: current, digest: computeMembersDigest(current) });
  }

  // ---- join / heartbeat / leave ----

  /**
   * What this node says about itself in a join and in every heartbeat (§3.3).
   * The request signature covers it, so a peer can take it as this node's word.
   */
  function selfDescription(): SelfDescription {
    const self = selfPeer();
    return {
      display_name: self.display_name,
      endpoints: self.endpoints,
      runtime: self.runtime,
      max_task_ttl_s: self.max_task_ttl_s,
      models: self.models,
      default_model: self.default_model,
      default_reasoning_effort: self.default_reasoning_effort,
    };
  }

  /**
   * The response carries no signature of its own, so it must not be able to
   * speak for a node other than the one we dialed (§7.1). First contact is TOFU:
   * with nothing to compare it with, any answer is taken.
   */
  function assertAnsweredBy(
    route: string,
    peerUrl: string,
    claimed: OrcaNodeId,
    expected: OrcaNodeId | undefined,
  ): void {
    if (expected !== undefined && claimed !== expected) {
      throw new Error(`${route} from ${peerUrl} claimed ${claimed} but ${expected} was expected`);
    }
  }

  async function join(peerUrl: string): Promise<JoinResponse> {
    // A first contact has no receiver id to sign to; a known URL must keep answering as the same node.
    const expected = client.idOf(peerUrl);
    const request: JoinRequest = { ...createAdmission("join", deps.key, ids), ...selfDescription() };
    const response = await client.call(
      peerUrl,
      { method: "POST", path: "/cluster/join", payload: request, reply: JoinResponseSchema },
      { target: expected ?? "" },
    );
    assertAnsweredBy("/cluster/join", peerUrl, response.self.orca_node_id, expected);
    membership.peers.upsert(response.self);
    client.learn(peerUrl, response.self.orca_node_id);
    membership.observeInbound(response.self.orca_node_id);
    membership.mergeRemote(response.members);
    emitMembersIfChanged();
    return response;
  }

  function sendHeartbeat(peerUrl: string, targetId: OrcaNodeId): Promise<HeartbeatResponse> {
    const request: HeartbeatRequest = {
      ...createAdmission("heartbeat", deps.key, ids),
      busy: deps.busy(),
      digest: digest(),
      self: selfDescription(),
    };
    return client.call(
      peerUrl,
      { method: "POST", path: "/cluster/heartbeat", payload: request, reply: HeartbeatResponseSchema },
      { target: targetId, timeoutMs: membership.timings.heartbeatTimeoutMs },
    );
  }

  /**
   * One heartbeat. The peer pruned our record (404) or no longer lists us as a
   * member (403): join once so it re-admits us, then send again. A real password
   * mismatch makes that join fail with 401, which the caller turns into a drop (§7.1).
   */
  async function heartbeatWithRejoin(peerUrl: string, targetId: OrcaNodeId): Promise<HeartbeatResponse> {
    try {
      return await sendHeartbeat(peerUrl, targetId);
    } catch (error) {
      if (!(error instanceof PodError && (error.status === 404 || error.code === "not_a_member"))) throw error;
      await join(peerUrl);
      return sendHeartbeat(peerUrl, targetId);
    }
  }

  /** Forget everything this node holds about a peer. */
  function forgetPeer(nodeId: OrcaNodeId): void {
    membership.remove(nodeId);
    preferredEndpoints.delete(nodeId);
    client.forget(nodeId);
  }

  /** Drop a node that failed admission: it is not part of this mesh anymore. */
  function dropPeer(nodeId: OrcaNodeId, reason: string): void {
    if (membership.get(nodeId) !== null) logger.warn(`orca-pod: dropping node ${nodeId} (${reason}, §7.1)`);
    membership.peers.remove(nodeId);
    forgetPeer(nodeId);
    emitMembersIfChanged();
  }

  /** `observeFailure: false` lets the caller count one failure per peer, not per URL. */
  async function pulse(peerUrl: string, targetId: OrcaNodeId, observeFailure: boolean): Promise<HeartbeatResponse> {
    try {
      const response = await heartbeatWithRejoin(peerUrl, targetId);
      assertAnsweredBy("/cluster/heartbeat", peerUrl, response.from, targetId);
      membership.observeInbound(response.from);
      membership.observeOutboundOk(response.from);
      if (response.members) membership.mergeRemote(response.members);
      emitMembersIfChanged();
      return response;
    } catch (error) {
      if (isAdmissionRejection(error)) {
        // This peer still uses another password: stop answering it and forget the
        // record (§7.1). Its own heartbeats to us fail identically, so the whole
        // old mesh drops the changed node instead of keeping it "online" forever.
        dropPeer(targetId, "workgroup admission rejected");
      } else if (observeFailure) {
        membership.observeOutboundFail(targetId);
      }
      throw error;
    }
  }

  /** Tell one peer we are leaving; true when it acknowledged. A peer that is already gone must not keep us from leaving. */
  async function notifyLeave(peer: PeerView): Promise<boolean> {
    const [endpoint] = peer.endpoints;
    if (endpoint === undefined) return false;
    try {
      await client.call(
        endpoint,
        { method: "POST", path: "/cluster/leave", reply: AckSchema },
        { target: peer.orca_node_id },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Leave the workgroup (§9.2): tell each peer, best effort, then clear the roster. */
  async function leave(): Promise<LeaveResult> {
    const left: OrcaNodeId[] = [];
    for (const peer of membership.list()) {
      if (await notifyLeave(peer)) left.push(peer.orca_node_id);
      forgetPeer(peer.orca_node_id);
    }
    emitMembersIfChanged();
    return { left };
  }

  // ---- endpoint screening and the heartbeat loop ----

  /** Last endpoint that worked per peer, tried first on the next round. */
  const preferredEndpoints = new Map<string, string>();
  /**
   * Screening verdicts per candidate endpoint, kept only briefly: a lookup per
   * tick would be wasteful, but a verdict kept for the whole process would never
   * notice that a name now points somewhere else.
   */
  const verdicts = new Map<string, { allowed: boolean; until: number }>();
  /** Peers whose refused endpoint was already logged; one line per peer is enough. */
  const warned = new Set<string>();

  /** An endpoint from another node's member list is screened before it is dialed (§7.7). */
  async function endpointAllowed(peer: PeerView, endpoint: string): Promise<boolean> {
    const now = Date.now();
    let verdict = verdicts.get(endpoint);
    if (verdict === undefined || verdict.until <= now) {
      const allowed = await candidateEndpointAllowed(endpoint, {
        allowPublicPeers: config.allow_public_peers,
        allowLoopbackPeers: config.allow_loopback_peers,
      });
      verdict = { allowed, until: now + VERDICT_TTL_MS };
      verdicts.set(endpoint, verdict);
    }
    if (!verdict.allowed && !warned.has(peer.orca_node_id)) {
      warned.add(peer.orca_node_id);
      logger.warn(`orca-pod: refusing candidate endpoint ${endpoint} from ${peer.orca_node_id} (§7.7)`);
    }
    return verdict.allowed;
  }

  /** Dialable URLs of one peer: screened if it came from a remote list, last good first. */
  async function dialOrder(peer: PeerView): Promise<string[]> {
    const candidate = membership.originOf(peer.orca_node_id) === "candidate";
    const allowed: string[] = [];
    for (const endpoint of peer.endpoints) {
      if (!candidate || (await endpointAllowed(peer, endpoint))) allowed.push(endpoint);
    }
    const preferred = preferredEndpoints.get(peer.orca_node_id);
    return preferred !== undefined && allowed.includes(preferred)
      ? [preferred, ...allowed.filter((endpoint) => endpoint !== preferred)]
      : allowed;
  }

  /**
   * Heartbeat one peer by trying its advertised URLs in order (IPv4/IPv6, LAN,
   * public): a single unreachable URL must not mark the peer offline (§7.7).
   */
  async function heartbeatPeer(peer: PeerView): Promise<void> {
    for (const endpoint of await dialOrder(peer)) {
      try {
        await pulse(endpoint, peer.orca_node_id, false);
        preferredEndpoints.set(peer.orca_node_id, endpoint);
        return;
      } catch (error) {
        // Every URL belongs to the same node, so a credential mismatch is final.
        if (isAdmissionRejection(error)) return;
      }
    }
    membership.observeOutboundFail(peer.orca_node_id);
  }

  let timer: NodeJS.Timeout | null = null;
  let stopped = true;

  function schedule(): void {
    if (stopped) return;
    // ±10% jitter: senders must not stay phase-locked, and the receiver's
    // suspect window (1.25 ticks) leaves room for this spread.
    timer = setTimeout(() => void tick(), membership.timings.intervalMs * (0.9 + Math.random() * 0.2));
    timer.unref();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    // §3.3: cadence follows mesh size (one pulse per node per second) so cluster traffic stays linear.
    if (deps.adaptiveHeartbeat) membership.setIntervalMs(heartbeatIntervalMsFor(membership.list().length + 1));
    membership.evaluate();
    const now = membership.now();
    const due = membership
      .list()
      .filter((peer) => peer.endpoints.length > 0 && membership.needsProbe(peer.orca_node_id, now));
    await Promise.allSettled(due.map(heartbeatPeer));
    emitMembersIfChanged();
    schedule();
  }

  return {
    self: () => ({ ...selfPeer(), workgroup_id: config.workgroup_id }),
    members: () => membership.list(),
    membersDigest: digest,
    setModelCatalog,
    modelDefaults: () => ({ model: defaultModel, reasoningEffort: defaultEffort }),
    join,
    async heartbeat(peerUrl) {
      return pulse(peerUrl, client.known(peerUrl), true);
    },
    async endpointsOf(nodeId) {
      const peer = membership.get(nodeId);
      return peer === null ? [] : dialOrder(peer);
    },
    leave,
    emitMembersIfChanged,
    start() {
      stopped = false;
      void tick();
      emitMembersIfChanged();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
