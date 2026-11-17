/** What an orca node tells an in-process listener (the UI panel) about (§9.2). */

import type { DispatchEntry } from "./dispatch.ts";
import type { PeerView } from "./peer.ts";
import type { TaskView } from "./task.ts";

/** Something a UI panel may want to re-render. */
export type PodEventInput =
  | { type: "task"; view: TaskView }
  | { type: "members"; members: PeerView[]; digest: string }
  | { type: "dispatch"; entry: DispatchEntry };

/** Emitted event with the wall-clock time it happened. */
export type PodEvent = PodEventInput & { at: string };

export type PodEventListener = (event: PodEvent) => void;
