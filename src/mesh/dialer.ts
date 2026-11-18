import type { NodeLogger } from "../core/events.ts";
import type { OrcaNodeId, PeerView } from "../core/wire/peer.ts";
import type { Membership } from "./membership.ts";
import { screenEndpoint, type DialPolicy } from "./screening.ts";

/** How long one candidate-endpoint screening verdict is reused (§7.7). */
const VERDICT_TTL_MS = 60_000;

/**
 * Which URL of a peer to dial, and in what order (§7.7). A URL that came from
 * someone else's member list is screened first; the one that last worked is
 * tried first on the next round.
 */
export class EndpointDialer {
  /** Last endpoint that worked per peer, tried first on the next round. */
  private readonly preferred = new Map<OrcaNodeId, string>();
  /**
   * Screening verdicts per candidate endpoint, kept only briefly: a lookup per
   * tick would be wasteful, but a verdict kept for the whole process would never
   * notice that a name now points somewhere else.
   */
  private readonly verdicts = new Map<string, { allowed: boolean; until: number }>();
  /** Peers whose refused endpoint was already logged; one line per peer is enough. */
  private readonly warned = new Set<OrcaNodeId>();

  constructor(
    private readonly membership: Membership,
    private readonly logger: NodeLogger,
    private readonly policy: DialPolicy,
  ) {}

  /** Dialable URLs of one peer: screened if it came from a remote list, last good first. */
  async dialOrder(peer: PeerView): Promise<string[]> {
    const candidate = this.membership.originOf(peer.orca_node_id) === "candidate";
    const allowed: string[] = [];
    for (const endpoint of peer.endpoints) {
      if (!candidate || (await this.endpointAllowed(peer, endpoint))) allowed.push(endpoint);
    }
    const preferred = this.preferred.get(peer.orca_node_id);
    return preferred !== undefined && allowed.includes(preferred)
      ? [preferred, ...allowed.filter((endpoint) => endpoint !== preferred)]
      : allowed;
  }

  /** Remember the URL that answered, so the next round tries it first. */
  prefer(nodeId: OrcaNodeId, endpoint: string): void {
    this.preferred.set(nodeId, endpoint);
  }

  forget(nodeId: OrcaNodeId): void {
    this.preferred.delete(nodeId);
  }

  /** An endpoint from another node's member list is screened before it is dialed (§7.7). */
  private async endpointAllowed(peer: PeerView, endpoint: string): Promise<boolean> {
    const now = Date.now();
    let verdict = this.verdicts.get(endpoint);
    if (verdict === undefined || verdict.until <= now) {
      const allowed = (await screenEndpoint(endpoint, this.policy)) === "allowed";
      verdict = { allowed, until: now + VERDICT_TTL_MS };
      this.verdicts.set(endpoint, verdict);
    }
    if (!verdict.allowed && !this.warned.has(peer.orca_node_id)) {
      this.warned.add(peer.orca_node_id);
      this.logger.warn(`orca-pod: refusing candidate endpoint ${endpoint} from ${peer.orca_node_id} (§7.7)`);
    }
    return verdict.allowed;
  }
}
