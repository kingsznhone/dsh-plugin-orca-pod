/**
 * In-process event bus for UI-facing state changes (§9.2).
 *
 * The node and the DSH plugin run in one process, so a UI panel does not need a
 * new wire protocol: it subscribes here instead of polling `tasks/get`. Events
 * are best-effort notifications, never a source of truth — a listener that
 * misses one recovers by reading `listTasks()` / `members()` again.
 *
 * Delivery is synchronous and a listener must never throw into the node: a UI
 * bug would otherwise break task execution.
 */

import type { DispatchEntry } from "./dispatches.ts";
import type { PeerView, TaskView } from "./protocol.ts";

/** Something a UI panel may want to re-render. */
export type PodEventInput =
  | { type: "task"; view: TaskView }
  | { type: "members"; members: PeerView[]; digest: string }
  | { type: "dispatch"; entry: DispatchEntry };

/** Emitted event with the wall-clock time it happened. */
export type PodEvent = PodEventInput & { at: string };

/** Emit side, used by the node; not exposed to UI consumers. */
type PodEventSink = (event: PodEventInput) => void;

/** Subscribe side, used by the plugin/admin surface. */
export type PodEventListener = (event: PodEvent) => void;

type PodEventBus = {
  emit: PodEventSink;
  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: PodEventListener): () => void;
};

export function createPodEventBus(): PodEventBus {
  const listeners = new Set<PodEventListener>();

  function emit(input: PodEventInput): void {
    if (listeners.size === 0) return;
    const event = { ...input, at: new Date().toISOString() } as PodEvent;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A UI listener must not break task execution or heartbeat.
      }
    }
  }

  function subscribe(listener: PodEventListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { emit, subscribe };
}
