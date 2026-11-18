import type { OrcaNodeId, PeerState, PeerView } from "../core/wire/peer.ts";

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

type PeerRecord = {
  view: PeerView;
  /** Explicit: joined or configured directly. Candidate: only seen in a remote list. */
  origin: PeerOrigin;
  last_ok_at: string | null;
  fails: number;
  suspect_reason: SuspectReason | null;
  last_recv_ms: number | null;
  last_ok_ms: number | null;
  probe_fails: number;
  next_probe_ms: number;
  offline_since_ms: number | null;
};

function resolveTimings(overrides: Partial<MembershipTimings> = {}): MembershipTimings {
  const merged = { ...DEFAULT_MEMBERSHIP_TIMINGS, ...overrides };
  if (overrides.intervalMs !== undefined && overrides.heartbeatTimeoutMs === undefined) {
    merged.heartbeatTimeoutMs = Math.max(100, Math.round(overrides.intervalMs / 2));
  }
  return merged;
}

function toView(record: PeerRecord): PeerView {
  return { ...record.view };
}

/**
 * The node's latest self-description replaces the recorded one, model catalog
 * included: a catalog it no longer advertises must not linger here (§3.3).
 */
function profilePatch(record: PeerRecord, view: PeerView): void {
  record.view.display_name = view.display_name;
  record.view.endpoints = view.endpoints;
  record.view.runtime = view.runtime;
  record.view.runtime_digest = view.runtime_digest;
  record.view.busy = view.busy ?? null;
  if (view.max_task_ttl_s !== undefined) record.view.max_task_ttl_s = view.max_task_ttl_s;
  record.view.models = view.models;
  record.view.default_model = view.default_model ?? null;
  record.view.default_reasoning_effort = view.default_reasoning_effort ?? null;
}

/** Move a record between online, suspect and offline by how long it has been quiet. */
function reassess(record: PeerRecord, nowMs: number, timings: MembershipTimings): void {
  if (record.view.state === "offline" || record.last_recv_ms === null) return;
  const age = nowMs - record.last_recv_ms;
  if (age >= timings.offlineAfterMs) {
    record.view.state = "offline";
    record.suspect_reason = null;
    record.offline_since_ms = nowMs;
    record.next_probe_ms = nowMs;
    return;
  }
  if (age >= timings.suspectAfterMs) {
    if (record.view.state === "online") {
      record.view.state = "suspect";
      record.suspect_reason = "quiet";
    } else if (record.suspect_reason === "unreachable") {
      record.suspect_reason = "quiet";
    }
    return;
  }
  if (record.view.state === "suspect") {
    record.view.state = "online";
    record.suspect_reason = null;
  }
}

/** A node that has been offline for the record TTL is forgotten. */
function shouldPrune(record: PeerRecord, nowMs: number, timings: MembershipTimings): boolean {
  return (
    record.view.state === "offline" &&
    record.offline_since_ms !== null &&
    nowMs - record.offline_since_ms >= timings.recordTtlMs
  );
}

export class Membership {
  private readonly current: MembershipTimings;
  private readonly monotonicMs: () => number;
  private readonly wallIso: () => string;
  private readonly records = new Map<OrcaNodeId, PeerRecord>();
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

  /** Monotonic clock used by this instance (same source as the watchdog). */
  now(): number {
    return this.monotonicMs();
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
    const nowMs = this.monotonicMs();
    if (existing) {
      profilePatch(existing, peer);
      existing.origin = "explicit";
      return;
    }
    // An explicit upsert is the node itself, admitted by a verified join (or
    // its answer to ours). Tombstones only keep stale *remote lists* from
    // reviving a removed id; they must not lock out a node that rejoins on its
    // own, or the gateway would answer 200 and then reject its every request.
    this.tombstones.delete(peer.orca_node_id);
    this.records.set(peer.orca_node_id, this.createRecord(peer, "online", nowMs, "explicit"));
  }

  get(orcaNodeId: OrcaNodeId): PeerView | undefined {
    const record = this.records.get(orcaNodeId);
    return record ? toView(record) : undefined;
  }

  list(): PeerView[] {
    return [...this.records.values()]
      .map(toView)
      .sort((left, right) => left.orca_node_id.localeCompare(right.orca_node_id));
  }

  /**
   * The members this node vouches for to others: the ones it has heard from
   * itself and that are not offline (§3.5). Candidates it never reached and
   * nodes gone quiet stay in `list()` but are never passed on.
   */
  directory(): PeerView[] {
    return this.list().filter((peer) => peer.state === "online" || peer.state === "suspect");
  }

  /** Forget a node; its id is tombstoned so a stale remote list cannot bring it back. */
  remove(orcaNodeId: OrcaNodeId): void {
    if (!this.records.delete(orcaNodeId)) return;
    this.tombstones.set(orcaNodeId, this.monotonicMs() + this.current.tombstoneMs);
  }

  /** Mark a peer as recently heard from. Returns false when the orca node is unknown. */
  touch(orcaNodeId: OrcaNodeId): boolean {
    const record = this.records.get(orcaNodeId);
    if (!record) return false;
    this.markOnline(record, this.monotonicMs());
    return true;
  }

  /** Whether a peer was joined explicitly or only seen in a remote list (§7.7). */
  originOf(orcaNodeId: OrcaNodeId): PeerOrigin | null {
    return this.records.get(orcaNodeId)?.origin ?? null;
  }

  isTombstoned(orcaNodeId: OrcaNodeId): boolean {
    const until = this.tombstones.get(orcaNodeId);
    if (until === undefined) return false;
    if (this.monotonicMs() < until) return true;
    this.tombstones.delete(orcaNodeId);
    return false;
  }

  // ---- evidence ----

  /** Record an inbound signed message from `orcaNodeId`; returns false when unknown. */
  observeInbound(orcaNodeId: OrcaNodeId): boolean {
    if (orcaNodeId === this.selfOrcaNodeId) return true;
    const record = this.records.get(orcaNodeId);
    if (!record) return false;
    this.markOnline(record, this.monotonicMs());
    return true;
  }

  observeOutboundOk(orcaNodeId: OrcaNodeId): void {
    const record = this.records.get(orcaNodeId);
    if (!record) return;
    record.last_ok_ms = this.monotonicMs();
    record.last_ok_at = this.wallIso();
    record.fails = 0;
    record.probe_fails = 0;
    record.next_probe_ms = 0;
    if (record.view.state === "suspect" && record.suspect_reason === "unreachable") {
      record.view.state = "online";
      record.suspect_reason = null;
    }
    if (record.view.state === "offline") {
      record.view.state = "online";
      record.offline_since_ms = null;
    }
  }

  observeOutboundFail(orcaNodeId: OrcaNodeId): void {
    const record = this.records.get(orcaNodeId);
    if (!record) return;
    record.fails += 1;
    const nowMs = this.monotonicMs();
    const timings = this.current;
    // A candidate never reached: give up after a few tries instead of dialing
    // someone else's memory forever; the tombstone keeps a stale list from
    // adding it straight back (§3.5).
    if (record.view.state === "unknown" && record.fails >= CANDIDATE_MAX_FAILURES) {
      this.remove(orcaNodeId);
      return;
    }
    if (record.view.state === "offline" || record.view.state === "unknown") {
      record.probe_fails += 1;
      const backoff = timings.recoverProbeMs * 2 ** (record.probe_fails - 1);
      record.next_probe_ms = nowMs + Math.min(backoff, timings.maxRecoverProbeMs);
      return;
    }
    const recentlyHeard = record.last_recv_ms !== null && nowMs - record.last_recv_ms <= timings.offlineAfterMs;
    const missThreshold = Math.max(1, Math.round(timings.suspectAfterMs / timings.intervalMs));
    if (record.fails >= missThreshold && recentlyHeard) {
      record.view.state = "suspect";
      record.suspect_reason = "unreachable";
    }
  }

  /** Remote lists only add records; they never touch online state. */
  mergeRemote(members: readonly PeerView[] | null | undefined): void {
    if (!members) return;
    const nowMs = this.monotonicMs();
    for (const member of members) {
      if (member.orca_node_id === this.selfOrcaNodeId) continue;
      if (this.isTombstoned(member.orca_node_id)) continue;
      // A third-party roster is only a hint for nodes we have never met (§7.1).
      // Once a record exists, only that node's own signed self-description may
      // update its endpoints or profile; otherwise any member could redirect
      // everyone's traffic to itself.
      if (this.records.get(member.orca_node_id)) continue;
      this.records.set(member.orca_node_id, this.createRecord(member, "unknown", nowMs, "candidate"));
    }
  }

  /** Apply timeout transitions and prune stale records. */
  evaluate(): PeerView[] {
    const nowMs = this.monotonicMs();
    for (const [orcaNodeId, record] of [...this.records]) {
      reassess(record, nowMs, this.current);
      if (shouldPrune(record, nowMs, this.current)) {
        this.records.delete(orcaNodeId);
        this.tombstones.set(orcaNodeId, nowMs + this.current.tombstoneMs);
      }
    }
    return [...this.records.values()].map(toView);
  }

  needsProbe(orcaNodeId: OrcaNodeId, nowMs: number): boolean {
    const record = this.records.get(orcaNodeId);
    if (!record) return false;
    // Offline nodes and unreached candidates are probed on the backoff schedule.
    if (record.view.state !== "offline" && record.view.state !== "unknown") return true;
    return nowMs >= record.next_probe_ms;
  }

  private createRecord(view: PeerView, state: PeerState, nowMs: number, origin: PeerOrigin): PeerRecord {
    return {
      view: { ...view, state, last_recv_at: state === "unknown" ? null : this.wallIso() },
      origin,
      last_ok_at: null,
      fails: 0,
      suspect_reason: null,
      last_recv_ms: state === "unknown" ? null : nowMs,
      last_ok_ms: null,
      probe_fails: 0,
      next_probe_ms: 0,
      offline_since_ms: state === "offline" ? nowMs : null,
    };
  }

  private markOnline(record: PeerRecord, nowMs: number): void {
    record.view.state = "online";
    record.view.last_recv_at = this.wallIso();
    record.suspect_reason = null;
    record.last_recv_ms = nowMs;
    record.fails = 0;
    record.probe_fails = 0;
    record.next_probe_ms = 0;
    record.offline_since_ms = null;
  }
}
