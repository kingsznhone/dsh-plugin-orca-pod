/** `orca-node members`: the member directory as this node (or a peer) sees it. */

import process from "node:process";

import type { MembersResponse } from "../protocol/index.ts";
import { normalizePeerUrl } from "../transport/index.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  localEndpoint,
  peerClient,
  type CommandArgs,
  type OptionName,
} from "./shared.ts";

export const options: readonly OptionName[] = [...COMMON_OPTIONS, "peer", "json"];

export async function run({ flags }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = flags.peer === undefined ? localEndpoint(config) : normalizePeerUrl(flags.peer);
  const response = await (await peerClient(config, peer)).call<MembersResponse>(peer, "GET", "/cluster/members");
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return 0;
  }
  const self = config.orca_node_id;
  process.stdout.write(`members ${response.members.length} digest ${response.members_digest.slice(0, 12)}\n`);
  for (const peerView of response.members) {
    const marker = peerView.orca_node_id === self ? "*" : " ";
    process.stdout.write(
      `${marker} ${peerView.orca_node_id}\t${peerView.endpoints.join(",") || "-"}\t${peerView.state}\t${peerView.display_name}\n`,
    );
  }
  return 0;
}
