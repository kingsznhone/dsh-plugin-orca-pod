import type { TrackerNode } from "../../src/plugin/tracker.ts";
import type { TaskView } from "../../src/task/wire.ts";

/** How a tracker test answers `tasks/get`. */
export type GetTask = (peer: string, taskId: string) => Promise<TaskView>;

/** A node that only answers `getTask`; the tracker touches nothing else of it in these tests. */
export function fakeTrackerNode(getTask: GetTask): TrackerNode {
  return {
    delegation: { getTask, log: { annotate() {} } },
    client: { idOf: () => undefined },
  } as unknown as TrackerNode;
}
