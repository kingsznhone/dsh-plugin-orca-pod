/** What an orca node tells an in-process listener (the UI panel) about (§9.2). */

import type { Stamped } from "../core/events.ts";
import type { MembersEvent } from "../mesh/wire.ts";
import type { DispatchEvent, TaskEvent } from "../task/wire.ts";

/** Something a UI panel may want to re-render. */
export type PodEventInput = TaskEvent | MembersEvent | DispatchEvent;

/** Emitted event with the wall-clock time it happened. */
export type PodEvent = Stamped<PodEventInput>;

export type PodEventListener = (event: PodEvent) => void;
