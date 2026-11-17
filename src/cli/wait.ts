/** `orca-node wait`: poll a task until it settles, escalating permission requests on the way. */

import { isTerminal, permissionRequestOf, type TaskView } from "../protocol/index.ts";
import { normalizePeerUrl } from "../transport/index.ts";
import { escalateToOrigin } from "./escalate.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  peerClient,
  positiveSeconds,
  printView,
  required,
  sleep,
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
  const deadline = timeoutS === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutS * 1000;
  const escalated = new Set<string>();
  let view = await client.rpc<TaskView>(peer, "tasks/get", { id: task });
  for (;;) {
    if (isTerminal(view.status.state)) break;
    if (view.status.state === "input-required") {
      const request = permissionRequestOf(view);
      if (request === null || localTask === undefined) break;
      if (!escalated.has(request.request_id)) {
        escalated.add(request.request_id);
        const seconds = Number.isFinite(deadline) ? Math.max(1, Math.round((deadline - Date.now()) / 1000)) : undefined;
        const outcome = await escalateToOrigin(config, client, peer, task, localTask, seconds);
        if (outcome.state === "input-required") {
          printView(view, flags);
          return 2;
        }
        view = await client.rpc<TaskView>(peer, "tasks/get", { id: task });
        continue;
      }
    }
    if (Date.now() >= deadline) {
      printView(view, flags);
      return 2;
    }
    await sleep(500);
    view = await client.rpc<TaskView>(peer, "tasks/get", { id: task });
  }
  printView(view, flags);
  if (view.status.state === "completed") return 0;
  if (view.status.state === "input-required") return 3;
  return 1;
}
