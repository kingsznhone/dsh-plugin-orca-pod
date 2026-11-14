import type { NodeId, PeerView, TaskView } from "./protocol.ts";

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

/**
 * Durable task record (§5.5). The view is the A2A `TaskView` the gateway
 * serves; the extra fields belong to the local store only.
 */
export type PersistedTask = {
  view: TaskView;
  origin_node: string;
  created_at: string;
  updated_at: string;
};

/**
 * Task store contract. One process writes it, one process reads it (§5.5):
 * no pooling, no service, no shared database.
 */
export interface TaskStore {
  save(task: PersistedTask): void;
  load(taskId: string): PersistedTask | undefined;
  list(): PersistedTask[];
  /** Durable stores release their handle; memory stores have nothing to close. */
  close?(): void;
}

function cloneTask(task: PersistedTask): PersistedTask {
  return JSON.parse(JSON.stringify(task)) as PersistedTask;
}

/** Protocol tests and harness nodes use this; the CLI/plugin wire SQLite. */
export function createMemoryTaskStore(initial: readonly PersistedTask[] = []): TaskStore {
  const tasks = new Map<string, PersistedTask>();
  for (const task of initial) tasks.set(task.view.id, cloneTask(task));
  return {
    save(task: PersistedTask): void {
      tasks.set(task.view.id, cloneTask(task));
    },
    load(taskId: string): PersistedTask | undefined {
      const task = tasks.get(taskId);
      return task ? cloneTask(task) : undefined;
    },
    list(): PersistedTask[] {
      return [...tasks.values()]
        .map(cloneTask)
        .sort((left, right) => left.updated_at.localeCompare(right.updated_at));
    },
  };
}
