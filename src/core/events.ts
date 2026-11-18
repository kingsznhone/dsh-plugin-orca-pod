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
 *
 * The bus does not know what an event holds; `node/events.ts` names the
 * events of an orca node.
 */

/** Where a component reports what it refuses or drops; the entry point decides where that goes. */
export type NodeLogger = { warn(message: string): void };

/** An emitted event with the wall-clock time it happened. */
export type Stamped<E> = E & { at: string };

export type EventBus<E extends object> = {
  emit(event: E): void;
  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: (event: Stamped<E>) => void): () => void;
};

export function createEventBus<E extends object>(): EventBus<E> {
  const listeners = new Set<(event: Stamped<E>) => void>();

  function emit(input: E): void {
    if (listeners.size === 0) return;
    const event = { ...input, at: new Date().toISOString() };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A UI listener must not break task execution or heartbeat.
      }
    }
  }

  function subscribe(listener: (event: Stamped<E>) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { emit, subscribe };
}
