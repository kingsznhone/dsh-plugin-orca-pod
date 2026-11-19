/** Plays the approval cue and the one-shot task-result cues. */

import React from "react";
import { playSound, type PodSound } from "./sounds.ts";
import { useStore } from "./store.ts";
import type { PodTaskRow } from "./types.ts";

/**
 * A silent overlay contribution: it draws nothing, but stays mounted for the
 * whole page so it can watch the shared snapshot even while no card is open.
 */
export function PodSounds() {
  const { state } = useStore();
  const knownApprovals = React.useRef<Set<string> | null>(null);
  const taskStates = React.useRef<Map<string, PodTaskRow["state"]> | null>(null);
  const soundedTasks = React.useRef<Set<string>>(new Set());

  // A request that was not in the previous snapshot: the card has just
  // appeared. Existing requests are seeded on the first snapshot, so a page
  // load or a plugin reload does not ring for prompts that were already there.
  React.useEffect(() => {
    if (state === null) return;
    const ids = new Set(state.approvals.map((approval) => approval.id));
    if (knownApprovals.current === null) {
      knownApprovals.current = ids;
      return;
    }
    let fresh = false;
    for (const id of ids) {
      if (!knownApprovals.current.has(id)) {
        fresh = true;
        break;
      }
    }
    knownApprovals.current = ids;
    if (fresh) playSound("approval");
  }, [state]);

  // A task that reaches `completed` or `failed` is a result. `canceled` is a
  // deliberate stop, not a success or a failure, so it stays silent. The first
  // snapshot seeds the states; only later transitions ring, and each task rings
  // at most once per page.
  React.useEffect(() => {
    if (state === null) return;
    if (taskStates.current === null) {
      taskStates.current = new Map(state.recent.map((task) => [task.id, task.state]));
      return;
    }
    let cue: PodSound | null = null;
    for (const task of state.recent) {
      const previous = taskStates.current.get(task.id);
      taskStates.current.set(task.id, task.state);
      if (soundedTasks.current.has(task.id)) continue;
      if (task.state !== "completed" && task.state !== "failed") continue;
      if (previous === task.state) continue;
      soundedTasks.current.add(task.id);
      cue = task.state === "failed" || cue === "failed" ? "failed" : "success";
    }
    if (cue !== null) playSound(cue);
  }, [state]);

  return null;
}
