import { errorMessage } from "./errors.ts";

/**
 * In-process notifications (§9.2).
 *
 * The node and the DSH plugin run in one process, so a UI panel does not need a
 * new wire protocol: it subscribes here instead of polling `tasks/get`. Events
 * are best-effort notifications, never a source of truth — a listener that
 * misses one recovers by reading `tasks.list()` / `membership.list()` again.
 *
 * Delivery is synchronous and a listener must never throw into the node: a UI
 * bug would otherwise break task execution.
 *
 * `EventBus` carries events; `ChangeSignal` only says "something changed, read
 * again". Neither knows what an event holds; `node/events.ts` names the events
 * of an orca node.
 */

/** Where a component reports what it refuses or drops; the entry point decides where that goes. */
export type NodeLogger = { warn(message: string): void };

/** An emitted event with the wall-clock time it happened. */
export type Stamped<E> = E & { at: string };

export class EventBus<E extends object> {
  private readonly listeners = new Set<(event: Stamped<E>) => void>();

  /** `logger`, when given, hears about a listener that threw; without it the failure is silent. */
  constructor(private readonly logger?: NodeLogger) {}

  emit(input: E): void {
    if (this.listeners.size === 0) return;
    const event = { ...input, at: new Date().toISOString() };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        // A UI listener must not break task execution or heartbeat.
        this.logger?.warn(`orca-pod: an event listener threw: ${errorMessage(error)}`);
      }
    }
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: (event: Stamped<E>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** A change without a payload: the subscriber re-reads whatever it renders. */
export class ChangeSignal {
  private readonly listeners = new Set<() => void>();

  /** `logger`, when given, hears about a listener that threw; without it the failure is silent. */
  constructor(private readonly logger?: NodeLogger) {}

  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tell every subscriber; one that throws does not stop the rest or the caller, but is reported. */
  notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        // A UI listener must not break the code that changed the state.
        this.logger?.warn(`orca-pod: a change listener threw: ${errorMessage(error)}`);
      }
    }
  }

  /** Drop every subscriber (the owner is shutting down). */
  clear(): void {
    this.listeners.clear();
  }
}
