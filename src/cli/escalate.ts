/** `orca-node escalate`: push a child's permission request up to this task's origin. */

import type { OrcaNodeConfig } from "../node/index.ts";
import { permissionRequestOf, type TaskRelay, type TaskView } from "../protocol/index.ts";
import { normalizePeerUrl, type PeerClient } from "../transport/index.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  localEndpoint,
  peerClient,
  positiveSeconds,
  printView,
  required,
  sleep,
  type CommandArgs,
  type OptionName,
} from "./shared.ts";

export const options: readonly OptionName[] = [...COMMON_OPTIONS, "peer", "task", "local-task", "timeout", "json"];

/**
 * Push a child's pending permission request up to the origin of `localTask`
 * (§7.12). Resolves once the local task leaves `input-required`.
 */
export async function escalateToOrigin(
  config: OrcaNodeConfig,
  client: PeerClient,
  childPeer: string,
  childTask: string,
  localTask: string,
  timeoutS: number | undefined,
): Promise<{ state: string; view: TaskView }> {
  const child = await client.rpc<TaskView>(childPeer, "tasks/get", { id: childTask });
  const request = permissionRequestOf(child);
  if (request === null) throw new Error(`task ${childTask} on ${childPeer} is not waiting for permission`);
  const relay: TaskRelay = { peer: childPeer, task_id: childTask, request };
  const local = localEndpoint(config);
  let view = await client.rpc<TaskView>(local, "tasks/escalate", { taskId: localTask, relay });
  const deadline = timeoutS === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutS * 1000;
  while (view.status.state === "input-required") {
    if (Date.now() >= deadline) return { state: view.status.state, view };
    await sleep(500);
    view = await client.rpc<TaskView>(local, "tasks/get", { id: localTask });
  }
  return { state: view.status.state, view };
}

/** Exit codes: 0 approved and this task is working again, 1 denied/failed, 2 timed out. */
export async function run({ flags }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = normalizePeerUrl(required(flags.peer, "peer"));
  const childTask = required(flags.task, "task");
  const localTask = required(flags["local-task"], "local-task");
  const timeoutS = positiveSeconds(flags.timeout, "timeout");

  const outcome = await escalateToOrigin(config, await peerClient(config, peer), peer, childTask, localTask, timeoutS);
  printView(outcome.view, flags);
  if (outcome.state === "working" || outcome.state === "completed") return 0;
  return outcome.state === "input-required" ? 2 : 1;
}
