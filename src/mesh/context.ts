import type { FileBlobRegistry } from "../core/blobs.ts";
import type { NodeLogger } from "../core/events.ts";
import type { NodeIdentity } from "../core/identity.ts";
import type { WorkgroupId } from "../core/wire/peer.ts";
import type { DispatchLog } from "../task/dispatch-log.ts";
import type { HttpPeerClient } from "./peer-client.ts";
import type { EndpointScreen } from "./screening.ts";
import type { MeshClock } from "./timings.ts";

/**
 * What every node of one mesh shares (§3.1): built once by whoever assembles the
 * node and handed to each `OrcaNode` as it is made, so a node needs no further
 * collaborators to act on its own behalf. One per orca instance, never a global:
 * several instances live in one process in tests and while a plugin reloads.
 */
export class MeshContext {
  constructor(
    /** Who this node is: its private key signs every request (§7.1). */
    readonly identity: NodeIdentity,
    readonly workgroupId: WorkgroupId,
    /** Signs and sends; it knows no node, the target is always named. */
    readonly client: HttpPeerClient,
    /** What this node handed to others, and what it last heard of it (§8.3). */
    readonly dispatches: DispatchLog,
    /** Files this node published (§5.6); a node that is this one serves from here. */
    readonly blobs: FileBlobRegistry,
    /** What this node concluded about the endpoints it was told of (§7.7). */
    readonly screening: EndpointScreen,
    readonly clock: MeshClock,
    readonly logger: NodeLogger,
  ) {}
}
