/**
 * Runs async operations one after another. A failed operation must not poison
 * the lane: its caller still sees the rejection, but the next operation starts
 * against a clean queue.
 */
export class SerialQueue {
  /** Settles when everything queued so far has; it never rejects. */
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
