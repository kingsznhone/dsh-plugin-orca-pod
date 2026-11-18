import { heartbeatIntervalMsFor, type Membership } from "./membership.ts";
import type { Workgroup } from "./workgroup.ts";

/**
 * The heartbeat loop (§3.3): once per interval it re-evaluates every record and
 * pulses the peers that are due. With `adaptive` the interval follows the mesh
 * size; pinned timings keep their period.
 */
export class HeartbeatLoop {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly membership: Membership,
    private readonly workgroup: Workgroup,
    private readonly adaptive: boolean,
  ) {}

  start(): void {
    this.stopped = false;
    void this.tick();
    this.workgroup.emitMembersIfChanged();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    // ±10% jitter: senders must not stay phase-locked, and the receiver's
    // suspect window (1.25 ticks) leaves room for this spread.
    this.timer = setTimeout(() => void this.tick(), this.membership.timings.intervalMs * (0.9 + Math.random() * 0.2));
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const { membership, workgroup } = this;
    // §3.3: cadence follows mesh size (one pulse per node per second) so cluster traffic stays linear.
    if (this.adaptive) membership.setIntervalMs(heartbeatIntervalMsFor(membership.list().length + 1));
    membership.evaluate();
    const now = membership.now();
    const due = membership
      .list()
      .filter((peer) => peer.endpoints.length > 0 && membership.needsProbe(peer.orca_node_id, now));
    await Promise.allSettled(due.map((peer) => workgroup.heartbeatPeer(peer)));
    workgroup.emitMembersIfChanged();
    this.schedule();
  }
}
