import { errorMessage, PodError } from "../core/errors.ts";
import type { NodeLogger } from "../core/events.ts";
import type { Workspace, WorkspaceUsage } from "./workspace.ts";

export type QuotaLimits = { maxBytes: number; maxFiles: number };

/**
 * The workspace quota (§6.13): a new task is refused while the group workspace
 * holds more than its limits. Usage is measured in the background: at startup,
 * after every task ends (only a running agent writes there) and after every
 * refusal. It is unknown until the first walk finishes, so a task is only
 * refused on a known overage.
 */
export class WorkspaceQuota {
  private usage: WorkspaceUsage | null = null;
  private walks = 0;

  constructor(
    private readonly workspace: Workspace,
    private readonly limits: QuotaLimits,
    private readonly logger: NodeLogger,
  ) {}

  /** Walk the workspace without blocking; a newer walk supersedes one that finishes late. */
  measure(): void {
    const walk = ++this.walks;
    this.workspace.measure().then(
      (measured) => {
        if (walk === this.walks) this.usage = measured;
      },
      (error: unknown) => this.logger.warn(`workspace usage could not be measured: ${errorMessage(error)}`),
    );
  }

  /** Throws `quota_exceeded` when the last measurement is over a limit, and measures again so a clean-up lifts it. */
  assertWithin(): void {
    const { usage } = this;
    if (usage === null) return;
    if (usage.bytes > this.limits.maxBytes || usage.files > this.limits.maxFiles) {
      this.measure();
      throw new PodError(
        "quota_exceeded",
        `the group workspace holds ${usage.files} files / ${usage.bytes} bytes, over its quota`,
      );
    }
  }
}
