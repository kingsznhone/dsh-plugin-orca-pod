/** `orca-node serve`: run an orca node from a config file until SIGINT/SIGTERM. */

import process from "node:process";

import {
  createOrcaNode,
  createPersistentStorage,
  endpointWriteback,
  joinRoster,
  loadConfig,
  parseSettings,
  saveConfig,
} from "../node/index.ts";
import { normalizePeerUrl } from "../transport/index.ts";
import { required, type CommandArgs, type OptionName } from "./shared.ts";

export const options: readonly OptionName[] = ["config", "peer", "bind", "port"];

export async function run({ flags }: CommandArgs): Promise<undefined> {
  const explicit = required(flags.config, "config");
  const config = await loadConfig(explicit);
  // Explicit listen overrides are useful for one-off runs and for the harness:
  // the persisted config keeps whatever the operator installed.
  const listen = parseSettings({
    bind_host: flags.bind ?? config.bind_host,
    port: flags.port === undefined ? config.port : Number(flags.port),
  });
  config.bind_host = listen.bind_host;
  config.port = listen.port;
  const orcaNode = createOrcaNode({ config, storage: createPersistentStorage(config), logger: console });
  const { url } = await orcaNode.start();
  const writeback = endpointWriteback(config, url);
  if (writeback !== null) await saveConfig(explicit, writeback);
  // `--peer` bootstraps a fresh node into an existing mesh at startup; the
  // harness (and `npm run harness`) relies on this to avoid a separate join step.
  if (flags.peer !== undefined) {
    const response = await orcaNode.join(normalizePeerUrl(flags.peer));
    await joinRoster(orcaNode, response.members);
  }
  process.stdout.write(`orca-node ${orcaNode.orcaNodeId} listening on ${url}\n`);

  const shutdown = (): void => {
    void orcaNode.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return undefined;
}
