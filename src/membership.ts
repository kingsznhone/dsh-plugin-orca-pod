import type { NodeId, PeerState, PeerView } from "./protocol.ts";
import type { PeerStore } from "./storage.ts";

/**
 * Membership bookkeeping (§3.3): the only evidence that a peer is online is the
 * local arrival time of its heartbeat. State lives here, never in someone
 * else's member list — remote lists are hints that only add records.
 */

export type SuspectReason = "quiet" | "unreachable";

export type MembershipTimings = {
  /** Heartbeat period; each node sends one every interval (+-20% jitter). */
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

export const DEFAULT_MEMBERSHIP_TIMINGS: MembershipTimings = {
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

export type PeerRecord = {
  view: PeerView;
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
  readonly selfNodeId: NodeId;
  readonly timings: MembershipTimings;
  /** Record an inbound signed message from `nodeId`; returns false when unknown. */
  observeInbound(nodeId: NodeId): boolean;
  observeOutboundOk(nodeId: NodeId): void;
  observeOutboundFail(nodeId: NodeId): void;
  /** Remote lists only add/update records; they never touch online state. */
  mergeRemote(members: readonly PeerView[] | null | undefined): void;
  /** Apply timeout transitions and prune stale records. */
  evaluate(): PeerView[];
  needsProbe(nodeId: NodeId, nowMs: number): boolean;
  /** Monotonic clock used by this instance (same source as the watchdog). */
  now(): number;
  list(): PeerView[];
  get(nodeId: NodeId): PeerView | null;
  getRecord(nodeId: NodeId): PeerRecord | null;
  findByEndpoint(endpoint: string): PeerView | null;
  remove(nodeId: NodeId): void;
  isTombstoned(nodeId: NodeId): boolean;
};

export type CreateMembershipOptions = {
  selfNodeId: NodeId;
  timings?: Partial<MembershipTimings>;
  clock?: MembershipClock;
};

export function resolveTimings(overrides: Partial<MembershipTimings> = {}): MembershipTimings {
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
  const selfNodeId = options.selfNodeId;
  const timings = resolveTimings(options.timings);
  const monotonicMs = options.clock?.monotonicMs ?? (() => performance.now());
  const wallIso = options.clock?.wallIso ?? (() => new Date().toISOString());
  const records = new Map<NodeId, PeerRecord>();
  const tombstones = new Map<NodeId, number>();
  const missThreshold = Math.max(1, Math.round(timings.suspectAfterMs / timings.intervalMs));

  function createRecord(view: PeerView, state: PeerState, nowMs: number): PeerRecord {
    return {
      view: { ...view, state, last_recv_at: state === "unknown" ? null : wallIso() },
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

  function profilePatch(record: PeerRecord, view: PeerView): void {
    record.view.display_name = view.display_name;
    record.view.endpoint = view.endpoint;
    record.view.runtime = view.runtime;
    record.view.runtime_digest = view.runtime_digest;
    record.view.busy = view.busy ?? null;
  }

  function getRecord(nodeId: NodeId): PeerRecord | null {
    return records.get(nodeId) ?? null;
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

  function remove(nodeId: NodeId): void {
    if (!records.delete(nodeId)) return;
    tombstones.set(nodeId, monotonicMs() + timings.tombstoneMs);
  }

  const peers: PeerStore = {
    upsert(peer: PeerView): void {
      if (peer.node_id === selfNodeId) return;
      const existing = records.get(peer.node_id);
      const nowMs = monotonicMs();
      if (existing) {
        profilePatch(existing, peer);
        return;
      }
      if (isTombstoned(peer.node_id)) return;
      records.set(peer.node_id, createRecord(peer, "online", nowMs));
    },
    get(nodeId: NodeId): PeerView | undefined {
      const record = records.get(nodeId);
      return record ? toView(record) : undefined;
    },
    list(): PeerView[] {
      return [...records.values()]
        .map(toView)
        .sort((left, right) => left.node_id.localeCompare(right.node_id));
    },
    remove(nodeId: NodeId): void {
      remove(nodeId);
    },
    touch(nodeId: NodeId, _at?: string): boolean {
      const record = records.get(nodeId);
      if (!record) return false;
      markOnline(record, monotonicMs());
      return true;
    },
  };

  function isTombstoned(nodeId: NodeId): boolean {
    const until = tombstones.get(nodeId);
    if (until === undefined) return false;
    if (monotonicMs() < until) return true;
    tombstones.delete(nodeId);
    return false;
  }

  function observeInbound(nodeId: NodeId): boolean {
    if (nodeId === selfNodeId) return true;
    const record = records.get(nodeId);
    if (!record) return false;
    markOnline(record, monotonicMs());
    return true;
  }

  function observeOutboundOk(nodeId: NodeId): void {
    const record = records.get(nodeId);
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

  function observeOutboundFail(nodeId: NodeId): void {
    const record = records.get(nodeId);
    if (!record) return;
    record.fails += 1;
    const nowMs = monotonicMs();
    if (record.view.state === "offline") {
      record.probe_fails += 1;
      const backoff = timings.recoverProbeMs * 2 ** (record.probe_fails - 1);
      record.next_probe_ms = nowMs + Math.min(backoff, timings.maxRecoverProbeMs);
      return;
    }
    const recentlyHeard =
      record.last_recv_ms !== null && nowMs - record.last_recv_ms <= timings.offlineAfterMs;
    if (record.fails >= missThreshold && recentlyHeard) {
      record.view.state = "suspect";
      record.suspect_reason = "unreachable";
    }
  }

  function mergeRemote(members: readonly PeerView[] | null | undefined): void {
    if (!members) return;
    const nowMs = monotonicMs();
    for (const member of members) {
      if (member.node_id === selfNodeId) continue;
      if (isTombstoned(member.node_id)) continue;
      const existing = records.get(member.node_id);
      if (existing) {
        profilePatch(existing, member);
        continue;
      }
      records.set(member.node_id, createRecord(member, "unknown", nowMs));
    }
  }

  function evaluate(): PeerView[] {
    const nowMs = monotonicMs();
    for (const [nodeId, record] of [...records]) {
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
        records.delete(nodeId);
        tombstones.set(nodeId, nowMs + timings.tombstoneMs);
      }
    }
    return [...records.values()].map(toView);
  }

  function needsProbe(nodeId: NodeId, nowMs: number): boolean {
    const record = records.get(nodeId);
    if (!record) return false;
    if (record.view.state !== "offline") return true;
    return nowMs >= record.next_probe_ms;
  }

  function findByEndpoint(endpoint: string): PeerView | null {
    for (const record of records.values()) {
      if (record.view.endpoint === endpoint) return toView(record);
    }
    return null;
  }

  function get(nodeId: NodeId): PeerView | null {
    const record = records.get(nodeId);
    return record ? toView(record) : null;
  }

  return {
    peers,
    selfNodeId,
    timings,
    observeInbound,
    observeOutboundOk,
    observeOutboundFail,
    mergeRemote,
    evaluate,
    needsProbe,
    now: monotonicMs,
    list: peers.list,
    get,
    getRecord,
    findByEndpoint,
    remove,
    isTombstoned,
  };
}
