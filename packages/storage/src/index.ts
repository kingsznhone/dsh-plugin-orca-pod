import type { NodeId, PeerView } from "@orca/protocol";

export * from "./blobs.ts";

/**
 * In-memory peer directory. The durable store (SQLite) implements the same
 * interface later; callers only depend on this contract.
 */
export interface PeerStore {
  upsert(peer: PeerView): void;
  get(nodeId: NodeId): PeerView | undefined;
  list(): PeerView[];
  remove(nodeId: NodeId): void;
  /** Mark a peer as recently heard from. Returns false when the node is unknown. */
  touch(nodeId: NodeId, at?: string): boolean;
}

export function createMemoryPeerStore(initial: readonly PeerView[] = []): PeerStore {
  const peers = new Map<NodeId, PeerView>();
  for (const peer of initial) peers.set(peer.node_id, { ...peer });
  return {
    upsert(peer: PeerView): void {
      peers.set(peer.node_id, { ...peer });
    },
    get(nodeId: NodeId): PeerView | undefined {
      const peer = peers.get(nodeId);
      return peer ? { ...peer } : undefined;
    },
    list(): PeerView[] {
      return [...peers.values()]
        .map((peer) => ({ ...peer }))
        .sort((left, right) => left.node_id.localeCompare(right.node_id));
    },
    remove(nodeId: NodeId): void {
      peers.delete(nodeId);
    },
    touch(nodeId: NodeId, at: string = new Date().toISOString()): boolean {
      const peer = peers.get(nodeId);
      if (!peer) return false;
      peer.state = "online";
      peer.last_recv_at = at;
      return true;
    },
  };
}
