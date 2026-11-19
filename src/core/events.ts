import { errorMessage } from "./errors.ts";

/** Where a component reports what it refuses or drops; the entry point decides where that goes. */
export type NodeLogger = { warn(message: string): void };

/**
 * A change without a payload: the subscriber re-reads whatever it depends on.
 * Delivery is synchronous, and a listener that throws is reported, never thrown
 * into the code that changed the state.
 */
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
        this.logger?.warn(`orca-pod: a change listener threw: ${errorMessage(error)}`);
      }
    }
  }
}
