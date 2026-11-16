/**
 * Origin-side dispatch log (§8, §13.4).
 *
 * A task belongs to the node that created it (`origin_orca_node`), and the target
 * keeps the durable record. The origin keeps its own small log of "what did I hand
 * to whom, and what did I last hear": after an origin restart the tasks it
 * dispatched are still running on other machines, and the origin must be able to
 * tell what it knows and what it no longer knows.
 *
 * The rule from §13.3: never turn "I cannot see it" into "it failed". Entries that
 * were still in flight when the process restarted are marked `unknown`, not failed;
 * polling a recovered entry replaces that with the real state again.
 */
export type DispatchEntry = {
  /** Task id returned by the target. */
  task_id: string;
  /** Target endpoint the task was dispatched to. */
  peer: string;
  context_id?: string;
  /** Last observed task state. */
  state: string;
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

/** States in which a task can no longer change. */
export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(["completed", "failed", "canceled"]);

export type DispatchStore = {
  save(entry: DispatchEntry): void;
  get(taskId: string): DispatchEntry | undefined;
  list(): DispatchEntry[];
  /**
   * On startup, mark every non-terminal entry `unknown` — the origin cannot know
   * what the remote task did while the origin was down (§13.3). Returns the count.
   */
  markUnknown(reason?: string): number;
  remove?(taskId: string): void;
  close?(): void;
};

export function createMemoryDispatchStore(): DispatchStore {
  const entries = new Map<string, DispatchEntry>();
  return {
    save(entry) {
      entries.set(entry.task_id, entry);
    },
    get(taskId) {
      return entries.get(taskId);
    },
    list() {
      return [...entries.values()].sort((left, right) => left.created_at.localeCompare(right.created_at));
    },
    markUnknown(reason = "origin_restart") {
      let count = 0;
      for (const [taskId, entry] of entries) {
        if (TERMINAL_TASK_STATES.has(entry.state)) continue;
        entries.set(taskId, {
          ...entry,
          state: "unknown",
          last_error: reason,
          updated_at: new Date().toISOString(),
        });
        count += 1;
      }
      return count;
    },
    remove(taskId) {
      entries.delete(taskId);
    },
  };
}
