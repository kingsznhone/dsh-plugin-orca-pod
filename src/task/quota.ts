import { errorMessage, PodError } from "../core/errors.ts";
import type { NodeLogger } from "../core/events.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The workspace quota (design.md 5.7): a new task is refused while the group workspace
 * holds more bytes than its limit. Usage is measured in the background: at startup,
 * after every task ends (only a running agent writes there) and after every
 * refusal. It is unknown until the first walk finishes, so a task is only
 * refused on a known overage.
 */
export class WorkspaceQuota {
  /** Bytes under the workspace root, as the last walk measured them. */
  private bytes: number | null = null;
  private walks = 0;

  constructor(
    private readonly workspace: Workspace,
    private readonly maxBytes: number,
    private readonly logger: NodeLogger,
  ) {}

  /** Walk the workspace without blocking; a newer walk supersedes one that finishes late. */
  measure(): void {
    const walk = ++this.walks;
    this.workspace.measure().then(
      (measured) => {
        if (walk === this.walks) this.bytes = measured;
      },
      (error: unknown) => this.logger.warn(`workspace usage could not be measured: ${errorMessage(error)}`),
    );
  }

  /** Throws `quota_exceeded` when the last measurement is over the limit, and measures again so a clean-up lifts it. */
  assertWithin(): void {
    const { bytes } = this;
    if (bytes === null || bytes <= this.maxBytes) return;
    this.measure();
    throw new PodError(
      "quota_exceeded",
      `the group workspace holds ${bytes} bytes, over its quota of ${this.maxBytes}`,
    );
  }
}
