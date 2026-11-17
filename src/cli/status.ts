/** `orca-node status`: print one task as its peer reports it. */

import { normalizePeerUrl } from "../transport/net.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  peerClient,
  printView,
  required,
  type CommandArgs,
  type OptionName,
} from "./shared.ts";

export const options: readonly OptionName[] = [...COMMON_OPTIONS, "peer", "task", "json"];

export async function run({ flags }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = normalizePeerUrl(required(flags.peer, "peer"));
  const task = required(flags.task, "task");
  const view = await (await peerClient(config, peer)).rpc(peer, "tasks/get", { id: task });
  printView(view, flags);
  return 0;
}
