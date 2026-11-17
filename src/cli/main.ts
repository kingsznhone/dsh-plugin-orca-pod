#!/usr/bin/env node
/** `orca-node`: parse the command line and hand it to one subcommand. */

import process from "node:process";

import { errorMessage } from "../kernel/errors.ts";
import * as fetch from "./fetch.ts";
import * as log from "./log.ts";
import * as members from "./members.ts";
import * as publish from "./publish.ts";
import * as send from "./send.ts";
import * as serve from "./serve.ts";
import { parseCli, type Command, type OptionName } from "./shared.ts";
import * as status from "./status.ts";
import * as wait from "./wait.ts";

const USAGE = `orca-node

Usage:
  orca-node serve   --config <path> [--peer <url>] [--bind <host>] [--port <n>]  start an orca node from a config file
  orca-node send    --peer <url> --text <text|-> [--context <id>] [--permission-mode <mode>] [--model <provider/model>] [--reasoning-effort <effort>] [--echo <json>] [--json]
  orca-node status  --peer <url> --task <id> [--json]
  orca-node wait    --peer <url> --task <id> [--timeout <seconds>] [--json]
  orca-node publish <path> [--ttl <seconds>] [--json]  let members fetch a file of this node; prints <node id>/<sha256>
  orca-node fetch   <node id>/<sha256> [--output <path>] [--json]  download a file a member published
  orca-node log [--json]                               tasks this node dispatched
  orca-node members [--peer <url>] [--json]
  orca-node --help                                      show this help

Common options:
  --config <path>       use a config file instead of <data-root>/config.json
  --data-root <path>    directory holding config.json (default $ORCA_POD_HOME, else
                        $DSH_PROFILE_DIR/orca-pod, else $DSH_HOME/orca-pod, else ~/.dsh/orca-pod)

Exit codes (wait):
  0 completed    1 failed/canceled    2 still running    3 input-required (a human decides on the origin)
  --timeout is optional: without it wait runs until the task settles or asks for a permission.

Tasks are single-hop: inside a task (ORCA_POD_IN_TASK=1) send is refused.
`;

function usageError(message: string): never {
  throw new Error(`${message}

${USAGE}`);
}

/** Every subcommand with the options it accepts; anything else is a usage error. */
const COMMANDS = { serve, send, status, wait, publish, fetch, log, members } satisfies Record<string, Command>;

type CommandName = keyof typeof COMMANDS;

function isCommand(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}

async function main(): Promise<void> {
  const { values: flags, positionals } = parseCli(process.argv.slice(2));
  const [name, ...rest] = positionals;
  if (flags.help === true || name === undefined || name === "help" || !isCommand(name)) {
    process.stdout.write(USAGE);
    if (flags.help !== true && name !== undefined && name !== "help") process.exitCode = 1;
    return;
  }
  const command: Command = COMMANDS[name];
  for (const option of Object.keys(flags) as OptionName[]) {
    if (!command.options.includes(option)) usageError(`--${option} is not an option of ${name}`);
  }
  const maxPositionals = command.maxPositionals ?? 0;
  if (rest.length > maxPositionals) usageError(`unexpected argument ${String(rest[maxPositionals])}`);
  const code = await command.run({ flags, positionals: rest });
  if (code !== undefined) process.exitCode = code;
}

main().catch((error: unknown) => {
  process.stderr.write(`orca-node: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
