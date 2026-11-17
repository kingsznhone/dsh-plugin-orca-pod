/** `orca-node wait`: poll a task until it settles, escalating permission requests on the way. */

import { setTimeout as sleep } from "node:timers/promises";

import { isTerminal, permissionRequestOf } from "../protocol/task.ts";
import { normalizePeerUrl } from "../transport/net.ts";
import { escalateToOrigin } from "./escalate.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  peerClient,
  positiveSeconds,
  printView,
  required,
  type CommandArgs,
  type OptionName,
} from "./shared.ts";

export const options: readonly OptionName[] = [...COMMON_OPTIONS, "peer", "task", "local-task", "timeout", "json"];

/** Exit codes: 0 completed, 1 failed/canceled, 2 still running, 3 input-required. */
export async function run({ flags }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = normalizePeerUrl(required(flags.peer, "peer"));
  const client = await peerClient(config, peer);
  const task = required(flags.task, "task");
  const localTask = flags["local-task"];
  const timeoutS = positiveSeconds(flags.timeout, "timeout");
  const deadlineMs = timeoutS === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutS * 1000;
  const escalated = new Set<string>();
  const refresh = () => client.rpc(peer, "tasks/get", { id: task });

  let view = await refresh();
  while (!isTerminal(view.status.state)) {
    const request = view.status.state === "input-required" ? permissionRequestOf(view) : null;
    if (view.status.state === "input-required" && (request === null || localTask === undefined)) break;
    if (request !== null && localTask !== undefined && !escalated.has(request.request_id)) {
      escalated.add(request.request_id);
      const settled = await escalateToOrigin(config, client, { peer, childTask: task, localTask }, deadlineMs);
      if (settled.status.state === "input-required") {
        printView(view, flags);
        return 2;
      }
      view = await refresh();
      continue;
    }
    if (Date.now() >= deadlineMs) {
      printView(view, flags);
      return 2;
    }
    await sleep(500);
    view = await refresh();
  }
  printView(view, flags);
  if (view.status.state === "completed") return 0;
  if (view.status.state === "input-required") return 3;
  return 1;
}
