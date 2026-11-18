import type { SessionId } from "@deepseek-ai/dsh-session";

import type { EventBus } from "../core/events.ts";
import type { DispatchStore } from "./dispatch-store.ts";
import { isTerminal, type DispatchEntry, type DispatchEvent, type TaskView } from "./wire.ts";

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
export class DispatchLog {
  constructor(
    private readonly store: DispatchStore,
    private readonly events: EventBus<DispatchEvent>,
  ) {}

  /** Entries, oldest first. */
  list(): DispatchEntry[] {
    return this.store.list();
  }

  /** Only `sendTask` means "this origin dispatched it": reads must never create entries. */
  recordSend(peerUrl: string, view: TaskView): void {
    const previous = this.store.get(view.id);
    const now = new Date().toISOString();
    this.save({
      ...previous,
      task_id: view.id,
      peer: peerUrl,
      context_id: view.contextId,
      state: view.status.state,
      last_error: view.status.reason,
      created_at: previous?.created_at ?? now,
      updated_at: now,
    });
  }

  /** Follow an existing entry after a read; the tracker and the panel read constantly. */
  refresh(view: TaskView): void {
    const previous = this.store.get(view.id);
    if (previous === undefined) return;
    if (previous.state === view.status.state && previous.last_error === view.status.reason) return;
    this.save({
      ...previous,
      state: view.status.state,
      last_error: view.status.reason,
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Remember which DSH session dispatched a task, so the host can resume
   * background tracking after a restart (§8.3). The entry must already exist;
   * unknown ids are ignored.
   */
  annotate(taskId: string, agentId: SessionId): void {
    const entry = this.store.get(taskId);
    if (entry !== undefined && entry.agent_id !== agentId) this.save({ ...entry, agent_id: agentId });
  }

  /**
   * On startup, mark every non-terminal entry `unknown` — the origin cannot know
   * what the remote task did while the origin was down. Returns the count.
   */
  markInFlightUnknown(): number {
    let count = 0;
    for (const entry of this.store.list()) {
      if (isTerminal(entry.state)) continue;
      this.store.save({
        ...entry,
        state: "unknown",
        last_error: "origin_restart",
        updated_at: new Date().toISOString(),
      });
      count += 1;
    }
    return count;
  }

  private save(entry: DispatchEntry): void {
    this.store.save(entry);
    this.events.emit({ type: "dispatch", entry });
  }
}
