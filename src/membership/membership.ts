import type { OrcaNodeId, PeerState, PeerView } from "../protocol/index.ts";

/** Peer directory contract; callers only depend on this interface. */
export interface PeerStore {
  upsert(peer: PeerView): void;
  get(orcaNodeId: OrcaNodeId): PeerView | undefined;
  list(): PeerView[];
  remove(orcaNodeId: OrcaNodeId): void;
  /** Mark a peer as recently heard from. Returns false when the orca node is unknown. */
  touch(orcaNodeId: OrcaNodeId): boolean;
}

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
  /** Heartbeat period; each orca node sends one every interval (+-20% jitter). */
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

/** How this orca node learned about a peer (§3.5, §7.7). */
type PeerOrigin = "explicit" | "candidate";

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

export type Membership = {
  /** PeerStore facade for the gateway (join / touch / busy update / remove). */
  readonly peers: PeerStore;
  readonly selfOrcaNodeId: OrcaNodeId;
  readonly timings: MembershipTimings;
  /** Retarget the expected cadence; also rederives suspect/offline/timeout windows. */
  setIntervalMs(intervalMs: number): void;
  /** Record an inbound signed message from `orcaNodeId`; returns false when unknown. */
  observeInbound(orcaNodeId: OrcaNodeId): boolean;
  observeOutboundOk(orcaNodeId: OrcaNodeId): void;
  observeOutboundFail(orcaNodeId: OrcaNodeId): void;
  /** Remote lists only add/update records; they never touch online state. */
  mergeRemote(members: readonly PeerView[] | null | undefined): void;
  /** Whether a peer was joined explicitly or only seen in a remote list (§7.7). */
  originOf(orcaNodeId: OrcaNodeId): PeerOrigin | null;
  /** Apply timeout transitions and prune stale records. */
  evaluate(): PeerView[];
  needsProbe(orcaNodeId: OrcaNodeId, nowMs: number): boolean;
  /** Monotonic clock used by this instance (same source as the watchdog). */
  now(): number;
  list(): PeerView[];
  get(orcaNodeId: OrcaNodeId): PeerView | null;
  getRecord(orcaNodeId: OrcaNodeId): PeerRecord | null;
  remove(orcaNodeId: OrcaNodeId): void;
  isTombstoned(orcaNodeId: OrcaNodeId): boolean;
};

type CreateMembershipOptions = {
  selfOrcaNodeId: OrcaNodeId;
  timings?: Partial<MembershipTimings>;
  clock?: MembershipClock;
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

export function createMembership(options: CreateMembershipOptions): Membership {
  const selfOrcaNodeId = options.selfOrcaNodeId;
  const timings = resolveTimings(options.timings);
  const monotonicMs = options.clock?.monotonicMs ?? (() => performance.now());
  const wallIso = options.clock?.wallIso ?? (() => new Date().toISOString());
  const records = new Map<OrcaNodeId, PeerRecord>();
  const tombstones = new Map<OrcaNodeId, number>();
  /** One missed tick is suspect, three is offline; jitter means a tick needs slack. */
  function setIntervalMs(intervalMs: number): void {
    timings.intervalMs = Math.round(intervalMs);
    timings.suspectAfterMs = Math.round(timings.intervalMs * 1.25);
    timings.offlineAfterMs = timings.intervalMs * 3;
    timings.heartbeatTimeoutMs = Math.max(100, Math.round(timings.intervalMs / 2));
  }

  function createRecord(view: PeerView, state: PeerState, nowMs: number, origin: PeerOrigin): PeerRecord {
    return {
      view: { ...view, state, last_recv_at: state === "unknown" ? null : wallIso() },
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

  function getRecord(orcaNodeId: OrcaNodeId): PeerRecord | null {
    return records.get(orcaNodeId) ?? null;
  }

  function markOnline(record: PeerRecord, nowMs: number): void {
    record.view.state = "online";
    record.view.last_recv_at = wallIso();
    record.suspect_reason = null;
    record.last_recv_ms = nowMs;
    record.fails = 0;
    record.probe_fails = 0;
    record.next_probe_ms = 0;
    record.offline_since_ms = null;
  }

  function remove(orcaNodeId: OrcaNodeId): void {
    if (!records.delete(orcaNodeId)) return;
    tombstones.set(orcaNodeId, monotonicMs() + timings.tombstoneMs);
  }

  const peers: PeerStore = {
    upsert(peer: PeerView): void {
      if (peer.orca_node_id === selfOrcaNodeId) return;
      const existing = records.get(peer.orca_node_id);
      const nowMs = monotonicMs();
      if (existing) {
        profilePatch(existing, peer);
        existing.origin = "explicit";
        return;
      }
      // An explicit upsert is the node itself, admitted by a verified join (or
      // its answer to ours). Tombstones only keep stale *remote lists* from
      // reviving a removed id; they must not lock out a node that rejoins on its
      // own, or the gateway would answer 200 and then reject its every request.
      tombstones.delete(peer.orca_node_id);
      records.set(peer.orca_node_id, createRecord(peer, "online", nowMs, "explicit"));
    },
    get(orcaNodeId: OrcaNodeId): PeerView | undefined {
      const record = records.get(orcaNodeId);
      return record ? toView(record) : undefined;
    },
    list(): PeerView[] {
      return [...records.values()]
        .map(toView)
        .sort((left, right) => left.orca_node_id.localeCompare(right.orca_node_id));
    },
    remove(orcaNodeId: OrcaNodeId): void {
      remove(orcaNodeId);
    },
    touch(orcaNodeId: OrcaNodeId): boolean {
      const record = records.get(orcaNodeId);
      if (!record) return false;
      markOnline(record, monotonicMs());
      return true;
    },
  };

  function isTombstoned(orcaNodeId: OrcaNodeId): boolean {
    const until = tombstones.get(orcaNodeId);
    if (until === undefined) return false;
    if (monotonicMs() < until) return true;
    tombstones.delete(orcaNodeId);
    return false;
  }

  function observeInbound(orcaNodeId: OrcaNodeId): boolean {
    if (orcaNodeId === selfOrcaNodeId) return true;
    const record = records.get(orcaNodeId);
    if (!record) return false;
    markOnline(record, monotonicMs());
    return true;
  }

  function observeOutboundOk(orcaNodeId: OrcaNodeId): void {
    const record = records.get(orcaNodeId);
    if (!record) return;
    record.last_ok_ms = monotonicMs();
    record.last_ok_at = wallIso();
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

  function observeOutboundFail(orcaNodeId: OrcaNodeId): void {
    const record = records.get(orcaNodeId);
    if (!record) return;
    record.fails += 1;
    const nowMs = monotonicMs();
    if (record.view.state === "offline") {
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

  function mergeRemote(members: readonly PeerView[] | null | undefined): void {
    if (!members) return;
    const nowMs = monotonicMs();
    for (const member of members) {
      if (member.orca_node_id === selfOrcaNodeId) continue;
      if (isTombstoned(member.orca_node_id)) continue;
      // A third-party roster is only a hint for nodes we have never met (§7.1).
      // Once a record exists, only that node's own signed self-description may
      // update its endpoints or profile; otherwise any member could redirect
      // everyone's traffic to itself.
      if (records.get(member.orca_node_id)) continue;
      records.set(member.orca_node_id, createRecord(member, "unknown", nowMs, "candidate"));
    }
  }

  function evaluate(): PeerView[] {
    const nowMs = monotonicMs();
    for (const [orcaNodeId, record] of [...records]) {
      if (record.view.state !== "offline" && record.last_recv_ms !== null) {
        const age = nowMs - record.last_recv_ms;
        if (age >= timings.offlineAfterMs) {
          record.view.state = "offline";
          record.suspect_reason = null;
          record.offline_since_ms = nowMs;
          record.next_probe_ms = nowMs;
        } else if (age >= timings.suspectAfterMs) {
          if (record.view.state === "online") {
            record.view.state = "suspect";
            record.suspect_reason = "quiet";
          } else if (record.suspect_reason === "unreachable") {
            record.suspect_reason = "quiet";
          }
        } else if (record.view.state === "suspect") {
          record.view.state = "online";
          record.suspect_reason = null;
        }
      }

      if (
        record.view.state === "offline" &&
        record.offline_since_ms !== null &&
        nowMs - record.offline_since_ms >= timings.recordTtlMs
      ) {
        records.delete(orcaNodeId);
        tombstones.set(orcaNodeId, nowMs + timings.tombstoneMs);
      }
    }
    return [...records.values()].map(toView);
  }

  function needsProbe(orcaNodeId: OrcaNodeId, nowMs: number): boolean {
    const record = records.get(orcaNodeId);
    if (!record) return false;
    if (record.view.state !== "offline") return true;
    return nowMs >= record.next_probe_ms;
  }

  function get(orcaNodeId: OrcaNodeId): PeerView | null {
    const record = records.get(orcaNodeId);
    return record ? toView(record) : null;
  }

  return {
    peers,
    selfOrcaNodeId,
    timings,
    setIntervalMs,
    observeInbound,
    observeOutboundOk,
    observeOutboundFail,
    mergeRemote,
    originOf: (orcaNodeId) => records.get(orcaNodeId)?.origin ?? null,
    evaluate,
    needsProbe,
    now: monotonicMs,
    list: peers.list,
    get,
    getRecord,
    remove,
    isTombstoned,
  };
}
