/**
 * The clocks of the mesh (design.md 2.5): how often a node is greeted, and how long it may
 * stay quiet before it is suspect, offline, forgotten. The only evidence that a
 * node is online is the local arrival time of its `hello`; state lives on the node
 * object here, never in someone else's member list.
 */

/**
 * Adaptive heartbeat cadence: each peer greets its peers once per interval, and
 * the interval follows the number of orca nodes in the workgroup (N seconds,
 * clamped to 2–10 s). Cluster-wide traffic stays linear in N instead of the
 * quadratic cost of a fixed tick.
 */
const HEARTBEAT_INTERVAL_MIN_MS = 2000;
const HEARTBEAT_INTERVAL_MAX_MS = 10_000;

/** One second per orca node, clamped so detection stays bounded on large meshes. */
export function heartbeatIntervalMsFor(orcaNodeCount: number): number {
  return Math.min(HEARTBEAT_INTERVAL_MAX_MS, Math.max(HEARTBEAT_INTERVAL_MIN_MS, orcaNodeCount * 1000));
}

export type MeshTimings = {
  /** Heartbeat period; each orca node sends one every interval (±10% jitter). */
  intervalMs: number;
  /** How long a peer may stay quiet before it becomes suspect. */
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
 * a reason to keep dialing it forever (design.md 2.6).
 */
export const CANDIDATE_MAX_FAILURES = 5;

/**
 * How long to wait before trying again an address or a node that did not answer
 * `fails` times in a row (design.md 2.5): `recoverProbeMs`, doubling with every failure,
 * at most `maxRecoverProbeMs`. Seeds and offline nodes back off alike.
 */
export function recoverDelayMs(fails: number, timings: MeshTimings): number {
  return Math.min(timings.recoverProbeMs * 2 ** (fails - 1), timings.maxRecoverProbeMs);
}

/**
 * The windows that follow from a cadence (design.md 2.5): one missed tick is suspect and
 * three are offline, with slack for jitter; a heartbeat may take half a tick, at
 * least 100 ms.
 */
export function windowsFor(intervalMs: number): {
  intervalMs: number;
  suspectAfterMs: number;
  offlineAfterMs: number;
  heartbeatTimeoutMs: number;
} {
  const interval = Math.round(intervalMs);
  return {
    intervalMs: interval,
    suspectAfterMs: Math.round(interval * 1.25),
    offlineAfterMs: interval * 3,
    heartbeatTimeoutMs: Math.max(100, Math.round(interval / 2)),
  };
}

/** The timings of a mesh: the windows of its cadence, then whatever the caller fixes. */
export function resolveTimings(overrides: Partial<MeshTimings> = {}): MeshTimings {
  return {
    recoverProbeMs: 15000,
    maxRecoverProbeMs: 30000,
    recordTtlMs: 7 * 24 * 60 * 60 * 1000,
    tombstoneMs: 10 * 60 * 1000,
    // A lone node starts at the shortest cadence; the adaptive tick retargets it (design.md 2.5).
    ...windowsFor(overrides.intervalMs ?? HEARTBEAT_INTERVAL_MIN_MS),
    ...overrides,
  };
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
