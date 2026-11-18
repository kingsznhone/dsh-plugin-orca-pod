import type { OrcaNodeId, PeerView } from "../core/wire/peer.ts";

/**
 * Membership bookkeeping (§3.3): the only evidence that a peer is online is the
 * local arrival time of its heartbeat. State lives here, never in someone
 * else's member list — remote lists are hints that only add records.
 */

type SuspectReason = "quiet" | "unreachable";

/**
 * Adaptive heartbeat cadence (§3.3): one heartbeat per peer per `N` seconds,
 * where N is the number of orca nodes in the workgroup. Cluster-wide traffic is
 * then ~N requests/second (linear) instead of the quadratic cost of a fixed tick.
 */
export const HEARTBEAT_INTERVAL_MIN_MS = 2000;
export const HEARTBEAT_INTERVAL_MAX_MS = 10_000;

/** One second per orca node, clamped so detection stays bounded on large meshes. */
export function heartbeatIntervalMsFor(orcaNodeCount: number): number {
  return Math.min(HEARTBEAT_INTERVAL_MAX_MS, Math.max(HEARTBEAT_INTERVAL_MIN_MS, orcaNodeCount * 1000));
}

export type MembershipTimings = {
  /** Heartbeat period; each orca node sends one every interval (±10% jitter). */
  intervalMs: number;
  /** Consecutive missed heartbeats before a peer becomes suspect. */
  suspectAfterMs: number;
  /** Missed-heartbeat horizon after which a peer leaves the online set. */
  offlineAfterMs: number;
  /** First probe delay after a peer goes offline. */
  recoverProbeMs: number;
  /** Cap for the exponential offline probe backoff. */
  maxRecoverProbeMs: number;
  /** How long an offline record is kept before it is pruned. */
  recordTtlMs: number;
  /** How long a removed/pruned id is tombstoned against stale lists. */
  tombstoneMs: number;
  /** Per-heartbeat request timeout (half the interval by convention). */
  heartbeatTimeoutMs: number;
};

/**
 * Consecutive failed heartbeats after which a candidate this node has never
 * reached is dropped (and tombstoned): someone else's memory of a node is not
 * a reason to keep dialing it forever (§3.5).
 */
export const CANDIDATE_MAX_FAILURES = 5;

const DEFAULT_MEMBERSHIP_TIMINGS: MembershipTimings = {
  intervalMs: 2000,
  suspectAfterMs: 6000,
  offlineAfterMs: 12000,
  recoverProbeMs: 15000,
  maxRecoverProbeMs: 30000,
  recordTtlMs: 7 * 24 * 60 * 60 * 1000,
  tombstoneMs: 10 * 60 * 1000,
  heartbeatTimeoutMs: 1000,
};

export type MembershipClock = {
  /** Monotonic milliseconds; used for every timeout decision. */
  monotonicMs?: () => number;
  /** Wall clock string; used only for display fields. */
  wallIso?: () => string;
};

/** What a `Membership` is built from besides its own id. */
export type MembershipOptions = {
  timings?: Partial<MembershipTimings>;
  clock?: MembershipClock;
};

/** How this orca node learned about a peer (§3.5, §7.7). */
export type PeerOrigin = "explicit" | "candidate";

/**
 * What this node knows about one peer: the view it lists plus the evidence
 * behind its state. The transitions live here; `Membership` keeps the
 * directory, the tombstones and the clock.
 */
class PeerEntry {
  private fails = 0;
  private suspectReason: SuspectReason | null = null;
  private probeFails = 0;
  private nextProbeMs = 0;
  private offlineSinceMs: number | null = null;

  private constructor(
    private readonly view: PeerView,
    /** Explicit: joined or configured directly. Candidate: only seen in a remote list. */
    private origin: PeerOrigin,
    private lastRecvMs: number | null,
  ) {}

  /** A node that proved itself with a verified join (or whose answer to ours we verified). */
  static explicit(view: PeerView, nowMs: number, wallIso: string): PeerEntry {
    return new PeerEntry({ ...view, state: "online", last_recv_at: wallIso }, "explicit", nowMs);
  }

  /** A node only seen in somebody else's list: never reached, so `unknown`. */
  static candidate(view: PeerView): PeerEntry {
    return new PeerEntry({ ...view, state: "unknown", last_recv_at: null }, "candidate", null);
  }

  get isCandidate(): boolean {
    return this.origin === "candidate";
  }

  get listed(): boolean {
    return this.view.state === "online" || this.view.state === "suspect";
  }

  snapshot(): PeerView {
    return { ...this.view };
  }

  /**
   * The node's own latest self-description replaces the recorded one, model
   * catalog included: a catalog it no longer advertises must not linger here
   * (§3.3). A node describing itself is an explicit member.
   */
  describe(view: PeerView): void {
    this.view.display_name = view.display_name;
    this.view.endpoints = view.endpoints;
    this.view.runtime = view.runtime;
    this.view.runtime_digest = view.runtime_digest;
    this.view.busy = view.busy ?? null;
    if (view.max_task_ttl_s !== undefined) this.view.max_task_ttl_s = view.max_task_ttl_s;
    this.view.models = view.models;
    this.view.default_model = view.default_model ?? null;
    this.view.default_reasoning_effort = view.default_reasoning_effort ?? null;
    this.origin = "explicit";
  }

  /** A signed message from the node arrived. */
  heard(nowMs: number, wallIso: string): void {
    this.view.state = "online";
    this.view.last_recv_at = wallIso;
    this.suspectReason = null;
    this.lastRecvMs = nowMs;
    this.fails = 0;
    this.probeFails = 0;
    this.nextProbeMs = 0;
    this.offlineSinceMs = null;
  }

  /** Our request to the node got an answer. */
  answered(): void {
    this.fails = 0;
    this.probeFails = 0;
    this.nextProbeMs = 0;
    if (this.view.state === "suspect" && this.suspectReason === "unreachable") {
      this.view.state = "online";
      this.suspectReason = null;
    }
    if (this.view.state === "offline") {
      this.view.state = "online";
      this.offlineSinceMs = null;
    }
  }

  /**
   * Our request to the node failed on every URL. A candidate never reached is
   * given up after a few tries instead of dialing someone else's memory
   * forever (§3.5); the caller removes it and tombstones the id.
   */
  missed(nowMs: number, timings: MembershipTimings): "drop" | "kept" {
    this.fails += 1;
    if (this.view.state === "unknown" && this.fails >= CANDIDATE_MAX_FAILURES) return "drop";
    if (this.view.state === "offline" || this.view.state === "unknown") {
      this.probeFails += 1;
      const backoff = timings.recoverProbeMs * 2 ** (this.probeFails - 1);
      this.nextProbeMs = nowMs + Math.min(backoff, timings.maxRecoverProbeMs);
      return "kept";
    }
    const recentlyHeard = this.lastRecvMs !== null && nowMs - this.lastRecvMs <= timings.offlineAfterMs;
    const missThreshold = Math.max(1, Math.round(timings.suspectAfterMs / timings.intervalMs));
    if (this.fails >= missThreshold && recentlyHeard) {
      this.view.state = "suspect";
      this.suspectReason = "unreachable";
    }
    return "kept";
  }

  /** Move between online, suspect and offline by how long the node has been quiet. */
  reassess(nowMs: number, timings: MembershipTimings): void {
    if (this.view.state === "offline" || this.lastRecvMs === null) return;
    const age = nowMs - this.lastRecvMs;
    if (age >= timings.offlineAfterMs) {
      this.view.state = "offline";
      this.suspectReason = null;
      this.offlineSinceMs = nowMs;
      this.nextProbeMs = nowMs;
      return;
    }
    if (age >= timings.suspectAfterMs) {
      if (this.view.state === "online") {
        this.view.state = "suspect";
        this.suspectReason = "quiet";
      } else if (this.suspectReason === "unreachable") {
        this.suspectReason = "quiet";
      }
      return;
    }
    if (this.view.state === "suspect") {
      this.view.state = "online";
      this.suspectReason = null;
    }
  }

  /** A node that has been offline for the record TTL is forgotten. */
  expired(nowMs: number, timings: MembershipTimings): boolean {
    return (
      this.view.state === "offline" &&
      this.offlineSinceMs !== null &&
      nowMs - this.offlineSinceMs >= timings.recordTtlMs
    );
  }

  /** Whether a heartbeat is due: offline nodes and unreached candidates are probed on the backoff schedule. */
  due(nowMs: number): boolean {
    if (this.view.endpoints.length === 0) return false;
    if (this.view.state !== "offline" && this.view.state !== "unknown") return true;
    return nowMs >= this.nextProbeMs;
  }
}

function resolveTimings(overrides: Partial<MembershipTimings> = {}): MembershipTimings {
  const merged = { ...DEFAULT_MEMBERSHIP_TIMINGS, ...overrides };
  if (overrides.intervalMs !== undefined && overrides.heartbeatTimeoutMs === undefined) {
    merged.heartbeatTimeoutMs = Math.max(100, Math.round(overrides.intervalMs / 2));
  }
  return merged;
}

export class Membership {
  private readonly current: MembershipTimings;
  private readonly monotonicMs: () => number;
  private readonly wallIso: () => string;
  private readonly records = new Map<OrcaNodeId, PeerEntry>();
  private readonly tombstones = new Map<OrcaNodeId, number>();

  constructor(
    readonly selfOrcaNodeId: OrcaNodeId,
    options: MembershipOptions = {},
  ) {
    this.current = resolveTimings(options.timings);
    this.monotonicMs = options.clock?.monotonicMs ?? (() => performance.now());
    this.wallIso = options.clock?.wallIso ?? (() => new Date().toISOString());
  }

  get timings(): Readonly<MembershipTimings> {
    return this.current;
  }

  /**
   * Retarget the expected cadence; also rederives the suspect, offline and
   * timeout windows. One missed tick is suspect, three is offline; jitter means
   * a tick needs slack.
   */
  setIntervalMs(intervalMs: number): void {
    const timings = this.current;
    timings.intervalMs = Math.round(intervalMs);
    timings.suspectAfterMs = Math.round(timings.intervalMs * 1.25);
    timings.offlineAfterMs = timings.intervalMs * 3;
    timings.heartbeatTimeoutMs = Math.max(100, Math.round(timings.intervalMs / 2));
  }

  // ---- the directory ----

  /** Record a node that proved itself with a verified join (or whose answer to ours we verified). */
  upsert(peer: PeerView): void {
    if (peer.orca_node_id === this.selfOrcaNodeId) return;
    const existing = this.records.get(peer.orca_node_id);
    if (existing) {
      existing.describe(peer);
      return;
    }
    // An explicit upsert is the node itself, admitted by a verified join (or
    // its answer to ours). Tombstones only keep stale *remote lists* from
    // reviving a removed id; they must not lock out a node that rejoins on its
    // own, or the gateway would answer 200 and then reject its every request.
    this.tombstones.delete(peer.orca_node_id);
    this.records.set(peer.orca_node_id, PeerEntry.explicit(peer, this.monotonicMs(), this.wallIso()));
  }

  get(orcaNodeId: OrcaNodeId): PeerView | undefined {
    return this.records.get(orcaNodeId)?.snapshot();
  }

  list(): PeerView[] {
    return this.sorted().map((entry) => entry.snapshot());
  }

  /**
   * The members this node vouches for to others: the ones it has heard from
   * itself and that are not offline (§3.5). Candidates it never reached and
   * nodes gone quiet stay in `list()` but are never passed on.
   */
  directory(): PeerView[] {
    return this.sorted()
      .filter((entry) => entry.listed)
      .map((entry) => entry.snapshot());
  }

  /** The members a heartbeat is due to: they have an address and are online, or their probe backoff has run out. */
  due(): PeerView[] {
    const nowMs = this.monotonicMs();
    return this.sorted()
      .filter((entry) => entry.due(nowMs))
      .map((entry) => entry.snapshot());
  }

  /** Forget a node; its id is tombstoned so a stale remote list cannot bring it back. */
  remove(orcaNodeId: OrcaNodeId): void {
    if (!this.records.delete(orcaNodeId)) return;
    this.tombstones.set(orcaNodeId, this.monotonicMs() + this.current.tombstoneMs);
  }

  /** Whether a peer was joined explicitly or only seen in a remote list (§7.7). */
  originOf(orcaNodeId: OrcaNodeId): PeerOrigin | null {
    const entry = this.records.get(orcaNodeId);
    return entry === undefined ? null : entry.isCandidate ? "candidate" : "explicit";
  }

  isTombstoned(orcaNodeId: OrcaNodeId): boolean {
    const until = this.tombstones.get(orcaNodeId);
    if (until === undefined) return false;
    if (this.monotonicMs() < until) return true;
    this.tombstones.delete(orcaNodeId);
    return false;
  }

  // ---- evidence ----

  /** Record an inbound signed message from `orcaNodeId`; returns false when it is not a member. */
  observeInbound(orcaNodeId: OrcaNodeId): boolean {
    if (orcaNodeId === this.selfOrcaNodeId) return true;
    const entry = this.records.get(orcaNodeId);
    if (!entry) return false;
    entry.heard(this.monotonicMs(), this.wallIso());
    return true;
  }

  observeOutboundOk(orcaNodeId: OrcaNodeId): void {
    this.records.get(orcaNodeId)?.answered();
  }

  observeOutboundFail(orcaNodeId: OrcaNodeId): void {
    const entry = this.records.get(orcaNodeId);
    if (entry?.missed(this.monotonicMs(), this.current) === "drop") {
      // The tombstone keeps a stale list from adding it straight back (§3.5).
      this.remove(orcaNodeId);
    }
  }

  /** Remote lists only add records; they never touch online state. */
  mergeRemote(members: readonly PeerView[]): void {
    for (const member of members) {
      if (member.orca_node_id === this.selfOrcaNodeId) continue;
      if (this.isTombstoned(member.orca_node_id)) continue;
      // A third-party roster is only a hint for nodes we have never met (§7.1).
      // Once a record exists, only that node's own signed self-description may
      // update its endpoints or profile; otherwise any member could redirect
      // everyone's traffic to itself.
      if (this.records.has(member.orca_node_id)) continue;
      this.records.set(member.orca_node_id, PeerEntry.candidate(member));
    }
  }

  /** Apply timeout transitions and prune stale records. */
  evaluate(): void {
    const nowMs = this.monotonicMs();
    for (const [orcaNodeId, entry] of [...this.records]) {
      entry.reassess(nowMs, this.current);
      if (entry.expired(nowMs, this.current)) this.remove(orcaNodeId);
    }
  }

  private sorted(): PeerEntry[] {
    return [...this.records.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entry);
  }
}
