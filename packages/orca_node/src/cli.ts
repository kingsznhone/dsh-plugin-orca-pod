#!/usr/bin/env node
import process from "node:process";

import { loadConfig } from "@orca/config";

import { createNode } from "./index.ts";

const USAGE = `orca-node

Usage:
  orca-node serve --config <path>   start a node from a config file
  orca-node --help                  show this help
`;

async function serve(args: string[]): Promise<void> {
  const configFlag = args.indexOf("--config");
  const configPath = configFlag === -1 ? undefined : args[configFlag + 1];
  if (!configPath) throw new Error("serve requires --config <path>");

  const node = createNode({ config: await loadConfig(configPath) });
  const { url } = await node.start();
  process.stdout.write(`orca-node ${node.nodeId} listening on ${url}\n`);

  const shutdown = (): void => {
    void node.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const [command, ...rest] = process.argv.slice(2);

if (command === "serve") {
  serve(rest).catch((error: unknown) => {
    process.stderr.write(`orca-node: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
} else {
  process.stdout.write(USAGE);
  if (command !== undefined && command !== "--help" && command !== "-h" && command !== "help") {
    process.exitCode = 1;
  }
}
