/**
 * Origin-side dispatch log (§8.3).
 *
 * A task belongs to the node that created it (`origin_orca_node`), and the target
 * keeps the durable record. The origin keeps its own small log of "what did I hand
 * to whom, and what did I last hear": after an origin restart the tasks it
 * dispatched are still running on other machines, and the origin must be able to
 * tell what it knows and what it no longer knows.
 *
 * The rule from §8.3: never turn "I cannot see it" into "it failed". Entries that
 * were still in flight when the process restarted are marked `unknown`, not failed;
 * polling a recovered entry replaces that with the real state again.
 */
import { isTerminal, type TaskState } from "./protocol.ts";

export type DispatchEntry = {
  /** Task id returned by the target. */
  task_id: string;
  /** Target endpoint the task was dispatched to. */
  peer: string;
  context_id?: string;
  /** Last observed task state; `unknown` once a restart cut the origin off from it. */
  state: TaskState | "unknown";
  last_error?: string;
  /** When the dispatching task was itself a local task, its id (for automatic relay). */
  parent_local_task_id?: string;
  /**
   * DSH session that dispatched the task (§8.3). Persisted so the host can
   * resume background tracking after a restart, when the in-memory tracker is
   * empty but the remote task may still be running.
   */
  agent_id?: string;
  created_at: string;
  updated_at: string;
};

export type DispatchStore = {
  save(entry: DispatchEntry): void;
  get(taskId: string): DispatchEntry | undefined;
  list(): DispatchEntry[];
  /**
   * On startup, mark every non-terminal entry `unknown` — the origin cannot know
   * what the remote task did while the origin was down (§8.3). Returns the count.
   */
  markUnknown(): number;
  remove(taskId: string): void;
  close(): void;
};

/** `markUnknown` for any store: rewrite each entry that was still in flight. */
export function markInFlightUnknown(store: Pick<DispatchStore, "list" | "save">): number {
  let count = 0;
  for (const entry of store.list()) {
    if (isTerminal(entry.state)) continue;
    store.save({ ...entry, state: "unknown", last_error: "origin_restart", updated_at: new Date().toISOString() });
    count += 1;
  }
  return count;
}

export function createMemoryDispatchStore(): DispatchStore {
  const entries = new Map<string, DispatchEntry>();
  const store: DispatchStore = {
    save(entry) {
      entries.set(entry.task_id, entry);
    },
    get: (taskId) => entries.get(taskId),
    list: () => [...entries.values()].sort((left, right) => left.created_at.localeCompare(right.created_at)),
    markUnknown: () => markInFlightUnknown(store),
    remove(taskId) {
      entries.delete(taskId);
    },
    close() {},
  };
  return store;
}
