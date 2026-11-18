import { resolve } from "node:path";

import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

import { shortenNodeId, type NodeIdentity } from "../core/identity.ts";
import type { OrcaNodeId, WorkgroupId } from "../core/wire/peer.ts";
import { nodeSettings, type NodeSettings, type Settings } from "./settings.ts";

/**
 * What a node is built from, in memory only: the node settings plus who the node
 * is. Nothing here is a secret and nothing is written down; the workgroup key and
 * the private key are handed to the node apart (§3.6).
 */
export type OrcaNodeConfig = NodeSettings & {
  orca_node_id: OrcaNodeId;
  display_name: string;
  workgroup_id: WorkgroupId;
  data_root: string;
};

/**
 * The data directory of the one orca node of this machine: `orca-pod` under the
 * DSH home (`$DSH_HOME`, default `~/.dsh`). A machine has one node however many
 * DSH profiles it runs, so settings, tasks and files are shared by all of them
 * (section 3.9 of the plan). There is no fallback to any earlier location.
 */
export function defaultDataRoot(
  /** The DSH home as the host resolved it (`ctx.dshHomePath()`); otherwise DSH's own rule over `env`. */
  dshHome?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return resolve(resolveDshHome(dshHome, env), "orca-pod");
}

/**
 * The config of the node `identity` names (the orca node id *is* its public key,
 * §7.1), from settings that have a workgroup.
 */
export function createOrcaNodeConfig(settings: Settings, identity: NodeIdentity, dataRoot: string): OrcaNodeConfig {
  const { workgroup_id } = settings;
  if (workgroup_id === undefined) throw new Error("workgroup_id is required");
  return {
    ...nodeSettings(settings),
    workgroup_id,
    data_root: dataRoot,
    orca_node_id: identity.orcaNodeId,
    display_name: settings.display_name ?? shortenNodeId(identity.orcaNodeId),
  };
}
