/** What an origin remembers about a task it handed to a peer (§8.3). */

import type { SessionId } from "@deepseek-ai/dsh-session";

import type { TaskState } from "./task.ts";

export type DispatchEntry = {
  /** Task id returned by the target. */
  task_id: string;
  /** Target endpoint the task was dispatched to. */
  peer: string;
  context_id?: string;
  /** Last observed task state; `unknown` once a restart cut the origin off from it. */
  state: TaskState | "unknown";
  last_error?: string;
  /**
   * DSH session that dispatched the task (§8.3). Persisted so the host can
   * resume background tracking after a restart, when the in-memory tracker is
   * empty but the remote task may still be running.
   */
  agent_id?: SessionId;
  created_at: string;
  updated_at: string;
};
