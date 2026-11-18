/**
 * The single slot of an orca node (§6.9): one task runs at a time. A task that
 * waits for a permission decision gives the slot up and takes it again when it
 * resumes.
 */
export class TaskSlot {
  private current: string | null = null;

  /** The task holding the slot, or null. */
  get holder(): string | null {
    return this.current;
  }

  isFree(): boolean {
    return this.current === null;
  }

  claim(taskId: string): void {
    this.current = taskId;
  }

  /** Only the holder can release; a task that no longer holds the slot changes nothing. */
  release(taskId: string): void {
    if (this.current === taskId) this.current = null;
  }
}
