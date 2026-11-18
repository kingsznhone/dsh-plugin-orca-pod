/**
 * The clocks of the mesh (§3.3): how often a node is greeted, and how long it may
 * stay quiet before it is suspect, offline, forgotten. The only evidence that a
 * node is online is the local arrival time of its `hello`; state lives on the node
 * object here, never in someone else's member list.
 */

/**
 * Adaptive heartbeat cadence (§3.3): one hello per peer per `N` seconds, where N
 * is the number of orca nodes in the workgroup. Cluster-wide traffic is then ~N
 * requests/second (linear) instead of the quadratic cost of a fixed tick.
 */
export const HEARTBEAT_INTERVAL_MIN_MS = 2000;
export const HEARTBEAT_INTERVAL_MAX_MS = 10_000;

/** One second per orca node, clamped so detection stays bounded on large meshes. */
export function heartbeatIntervalMsFor(orcaNodeCount: number): number {
  return Math.min(HEARTBEAT_INTERVAL_MAX_MS, Math.max(HEARTBEAT_INTERVAL_MIN_MS, orcaNodeCount * 1000));
}

export type MeshTimings = {
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

const DEFAULT_TIMINGS: MeshTimings = {
  intervalMs: 2000,
  suspectAfterMs: 6000,
  offlineAfterMs: 12000,
  recoverProbeMs: 15000,
  maxRecoverProbeMs: 30000,
  recordTtlMs: 7 * 24 * 60 * 60 * 1000,
  tombstoneMs: 10 * 60 * 1000,
  heartbeatTimeoutMs: 1000,
};

export function resolveTimings(overrides: Partial<MeshTimings> = {}): MeshTimings {
  const merged = { ...DEFAULT_TIMINGS, ...overrides };
  if (overrides.intervalMs !== undefined && overrides.heartbeatTimeoutMs === undefined) {
    merged.heartbeatTimeoutMs = Math.max(100, Math.round(overrides.intervalMs / 2));
  }
  return merged;
}

/** Where the mesh reads the time; tests inject their own. */
export type MeshClock = {
  /** Monotonic milliseconds; used for every timeout decision. */
  monotonicMs: () => number;
  /** Wall clock string; used only for display fields. */
  wallIso: () => string;
};

export function resolveClock(overrides: Partial<MeshClock> = {}): MeshClock {
  return {
    monotonicMs: overrides.monotonicMs ?? (() => performance.now()),
    wallIso: overrides.wallIso ?? (() => new Date().toISOString()),
  };
}
