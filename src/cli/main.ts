#!/usr/bin/env node
/** `orca-node`: parse the command line and hand it to one subcommand. */

import process from "node:process";

import { errorMessage } from "../kernel/errors.ts";
import * as escalate from "./escalate.ts";
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
  orca-node send    --peer <url> --text <text|-> [--file <path> ...] [--local-task <this task>] [--context <id>] [--permission-mode <mode>] [--model <provider/model>] [--reasoning-effort <effort>] [--echo <json>] [--json]
  orca-node status  --peer <url> --task <id> [--json]
  orca-node wait    --peer <url> --task <id> [--local-task <this task>] [--timeout <seconds>] [--json]
  orca-node escalate --peer <child> --task <child task> --local-task <this task> [--timeout <s>] [--json]
  orca-node publish <path> [--ttl <seconds>] [--json]  expose a produced file as a blob URL
  orca-node log [--json]                               tasks this node dispatched
  orca-node members [--peer <url>] [--json]
  orca-node --help                                      show this help

Common options:
  --config <path>       use a config file instead of <data-root>/config.json
  --data-root <path>    directory holding config.json (default $ORCA_POD_HOME, else
                        $DSH_PROFILE_DIR/orca-pod, else $DSH_HOME/orca-pod, else ~/.dsh/orca-pod)

Exit codes (wait):
  0 completed    1 failed/canceled    2 still running    3 input-required
  With --local-task, a child permission request is escalated to this task's origin
  automatically; wait keeps going after the decision (3 only if it cannot escalate).
  --timeout is optional: without it the origin may take as long as it needs.

With --local-task on send, this node watches the child task and parks this task
automatically when the child asks for a permission; the origin then decides once.

Exit codes (escalate):
  0 approved and this task is working again    1 denied/failed    2 timed out
`;

function usageError(message: string): never {
  throw new Error(`${message}

${USAGE}`);
}

/** Every subcommand with the options it accepts; anything else is a usage error. */
const COMMANDS = { serve, send, status, wait, escalate, publish, log, members } satisfies Record<string, Command>;

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
