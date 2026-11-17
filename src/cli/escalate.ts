/** `orca-node escalate`: push a child's permission request up to this task's origin. */

import { setTimeout as sleep } from "node:timers/promises";

import type { OrcaNodeConfig } from "../node/config.ts";
import { permissionRequestOf, type TaskView } from "../protocol/task.ts";
import type { PeerClient } from "../protocol/client.ts";
import type { TaskRelay } from "../protocol/grant.ts";
import { normalizePeerUrl } from "../transport/net.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  localEndpoint,
  peerClient,
  positiveSeconds,
  printView,
  required,
  type CommandArgs,
  type OptionName,
} from "./shared.ts";

export const options: readonly OptionName[] = [...COMMON_OPTIONS, "peer", "task", "local-task", "timeout", "json"];

/** The child task that is waiting for a permission, and the local task that delegated to it. */
export type EscalationTarget = {
  /** Endpoint of the orca node running the child task. */
  peer: string;
  childTask: string;
  localTask: string;
};

/**
 * Push a child's pending permission request up to the origin of `localTask`
 * (§7.12). Resolves with the local task once it leaves `input-required`, or
 * with the still-waiting task at `deadlineMs` (epoch milliseconds).
 */
export async function escalateToOrigin(
  config: OrcaNodeConfig,
  client: PeerClient,
  target: EscalationTarget,
  deadlineMs: number,
): Promise<TaskView> {
  const { peer, childTask, localTask } = target;
  const child = await client.rpc(peer, "tasks/get", { id: childTask });
  const request = permissionRequestOf(child);
  if (request === null) throw new Error(`task ${childTask} on ${peer} is not waiting for permission`);
  const relay: TaskRelay = { peer, task_id: childTask, request };
  const local = localEndpoint(config);
  let view = await client.rpc(local, "tasks/escalate", { taskId: localTask, relay });
  while (view.status.state === "input-required" && Date.now() < deadlineMs) {
    await sleep(500);
    view = await client.rpc(local, "tasks/get", { id: localTask });
  }
  return view;
}

/** Exit codes: 0 approved and this task is working again, 1 denied/failed, 2 timed out. */
export async function run({ flags }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = normalizePeerUrl(required(flags.peer, "peer"));
  const target = {
    peer,
    childTask: required(flags.task, "task"),
    localTask: required(flags["local-task"], "local-task"),
  };
  const timeoutS = positiveSeconds(flags.timeout, "timeout");
  const deadlineMs = timeoutS === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutS * 1000;

  const view = await escalateToOrigin(config, await peerClient(config, peer), target, deadlineMs);
  printView(view, flags);
  const { state } = view.status;
  if (state === "working" || state === "completed") return 0;
  return state === "input-required" ? 2 : 1;
}
