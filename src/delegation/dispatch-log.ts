/**
 * Origin-side dispatch log (§8.3).
 *
 * A task belongs to the node that created it (`origin_orca_node`), and the target
 * keeps the durable record. The origin keeps its own small log of "what did I hand
 * to whom, and what did I last hear": after an origin restart the tasks it
 * dispatched are still running on other machines, and the origin must be able to
 * tell what it knows and what it no longer knows.
 *
 * The rule from §8.3: never turn "I cannot see it" into "it failed". Entries that
 * were still in flight when the process restarted are marked `unknown`, not failed;
 * polling a recovered entry replaces that with the real state again.
 */

import { isTerminal } from "../protocol/index.ts";
import type { DispatchStore } from "../storage/index.ts";

/**
 * On startup, mark every non-terminal entry `unknown` — the origin cannot know
 * what the remote task did while the origin was down (§8.3). Returns the count.
 */
export function markInFlightUnknown(store: Pick<DispatchStore, "list" | "save">): number {
  let count = 0;
  for (const entry of store.list()) {
    if (isTerminal(entry.state)) continue;
    store.save({ ...entry, state: "unknown", last_error: "origin_restart", updated_at: new Date().toISOString() });
    count += 1;
  }
  return count;
}
