#!/usr/bin/env node
/**
 * `orca-pod <command>` launcher.
 *
 * Today there is one command: `install`, which registers the host listener
 * (`orca-node serve`) as a systemd service. Users who want the web panel install
 * DeepSeek Harness themselves and add the plugin from its web UI; this command
 * deliberately has no `web` mode.
 *
 * Planning and rendering live in `src/install.ts`; this file owns argument
 * parsing, the interactive readline session and console output.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  checkDsh,
  installQuestions,
  installService,
  planInstall,
  promptForInstall,
  renderUnit,
  resolveEnvironment,
  type InstallEnvironment,
  type InstallOptions,
  type PromptFn,
  type PromptQuestion,
} from "./install.ts";

const USAGE = `Usage: orca-pod install [options]

Register this machine's orca-pod host node as a systemd service. The unit runs
\`orca-node serve\`, so the node keeps listening without a browser or desktop app.
Run it without flags in a terminal for an interactive setup, or pass every answer
as a flag (recommended when an agent installs over SSH): then install is fully
non-interactive.

Options:
  --workgroup <id>      Workgroup id
  --password <secret>   Workgroup password (prefer --password-stdin on shared shells)
  --password-stdin      Read the workgroup password from stdin
  --data-root <path>    Node data directory (default: ~/.orca-pod)
  --bind-host <addr>    Listen address (default: ::, all interfaces)
  --port <number>       Listen port (default: 11811)
  --endpoint <url>      Advertised endpoint; repeatable
  --display-name <name> Human-readable node name
  --service-name <name> systemd unit name (default: orca-pod)
  --system              Install a system-wide unit under /etc/systemd/system
  --no-start            Write the unit but do not enable/start it
  --force               Rewrite an existing unit and node config
  --dry-run             Print the plan without writing anything
  --non-interactive     Fail instead of prompting when answers are missing
  --skip-dsh-check      Do not require \`dsh --version\` to succeed
  -h, --help            Show this help

Examples:
  npx orca-pod install
  npx orca-pod install --workgroup lab --password-stdin < secret.txt --non-interactive
  sudo npx orca-pod install --system --workgroup lab --password-stdin < secret.txt
  npx orca-pod install --dry-run --workgroup lab --password '...'
`;

interface ParsedArguments {
  command: string | null;
  values: Map<string, string[]>;
  booleans: Set<string>;
}

const VALUE_FLAGS = new Set([
  "workgroup",
  "password",
  "data-root",
  "bind-host",
  "port",
  "endpoint",
  "display-name",
  "service-name",
  "dsh-bin",
]);

const BOOLEAN_FLAGS = new Set([
  "system",
  "no-start",
  "force",
  "dry-run",
  "non-interactive",
  "password-stdin",
  "skip-dsh-check",
  "help",
]);

export function parseArguments(argv: string[]): ParsedArguments {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  let command: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") {
      booleans.add("help");
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        booleans.add(name);
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`--${name} needs a value`);
        }
        const list = values.get(name) ?? [];
        list.push(value);
        values.set(name, list);
        index += 1;
        continue;
      }
      throw new Error(`unknown option --${name}`);
    }
    if (command === null) {
      command = token;
      continue;
    }
    throw new Error(`unexpected argument ${token}`);
  }
  return { command, values, booleans };
}

function first(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.values.get(name)?.[0];
}

function numberFlag(parsed: ParsedArguments, name: string): number | undefined {
  const raw = first(parsed, name);
  if (raw === undefined) return undefined;
  const parsedNumber = Number(raw);
  if (!Number.isInteger(parsedNumber) || parsedNumber < 0 || parsedNumber > 65535) {
    throw new Error(`--${name} must be an integer between 0 and 65535`);
  }
  return parsedNumber;
}

export interface MainDeps {
  /** Defaults to `process.stdin.isTTY`. */
  interactive?: boolean;
  /** Defaults to a readline session on stdin/stdout. */
  prompt?: PromptFn;
  /** Defaults to reading stdin as UTF-8 (for --password-stdin). */
  readStdin?: () => string;
  environment?: Partial<InstallEnvironment>;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
}

function defaultPrompt(): PromptFn {
  return async (question: PromptQuestion) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const suffix = question.default === undefined ? "" : ` [${question.default}]`;
    const message = `${question.message}${suffix}: `;
    try {
      if (question.secret === true && process.stdout.isTTY === true) {
        process.stdout.write(message);
        const mutable = rl as unknown as { _writeToOutput?: (text: string) => void };
        const original = mutable._writeToOutput;
        mutable._writeToOutput = () => undefined;
        try {
          return await rl.question("");
        } finally {
          mutable._writeToOutput = original;
          process.stdout.write("\n");
        }
      }
      return await rl.question(message);
    } finally {
      rl.close();
    }
  };
}

function missingAnswerFlags(questions: readonly PromptQuestion[]): string {
  const flags: string[] = [];
  for (const question of questions) {
    if (question.option === "workgroup") flags.push("--workgroup");
    else if (question.option === "password") flags.push("--password or --password-stdin");
    else if (question.option === "bind-host") flags.push("--bind-host");
    else if (question.option === "port") flags.push("--port");
  }
  return flags.join(", ");
}

export async function main(argv: string[] = process.argv.slice(2), deps: MainDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => console.log(text));
  const writeError = deps.writeError ?? ((text: string) => console.error(text));
  const parsed = parseArguments(argv);
  if (parsed.booleans.has("help") || parsed.command === null) {
    write(USAGE);
    return 0;
  }
  if (parsed.command !== "install") {
    writeError(`unknown command ${parsed.command}\n\n${USAGE}`);
    return 2;
  }

  const readStdin = deps.readStdin ?? (() => readFileSync(0, "utf8"));
  const passwordFromStdin = parsed.booleans.has("password-stdin") ? readStdin().trim() : undefined;
  const dataRoot = first(parsed, "data-root");
  const options: InstallOptions = {
    system: parsed.booleans.has("system"),
    noStart: parsed.booleans.has("no-start"),
    force: parsed.booleans.has("force"),
    ...(dataRoot === undefined ? {} : { dataRoot }),
    ...(first(parsed, "service-name") === undefined ? {} : { serviceName: first(parsed, "service-name")! }),
    ...(first(parsed, "workgroup") === undefined ? {} : { workgroupId: first(parsed, "workgroup")! }),
    ...(first(parsed, "password") === undefined ? {} : { password: first(parsed, "password")! }),
    ...(passwordFromStdin === undefined || passwordFromStdin === "" ? {} : { password: passwordFromStdin }),
    ...(first(parsed, "display-name") === undefined ? {} : { displayName: first(parsed, "display-name")! }),
    ...(first(parsed, "bind-host") === undefined ? {} : { bindHost: first(parsed, "bind-host")! }),
    ...(numberFlag(parsed, "port") === undefined ? {} : { port: numberFlag(parsed, "port")! }),
    ...(parsed.values.get("endpoint") === undefined ? {} : { endpoints: [...parsed.values.get("endpoint")!] }),
  };
  const environment = resolveEnvironment({
    ...(first(parsed, "dsh-bin") === undefined ? {} : { dshBin: first(parsed, "dsh-bin")! }),
    packageEntry: fileURLToPath(new URL("./cli.ts", import.meta.url)),
    ...deps.environment,
  });
  const plan = planInstall(options, environment);

  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  let answers: InstallOptions = options;
  const questions = installQuestions(plan, answers);
  if (questions.length > 0) {
    if (deps.interactive === false || !interactive || parsed.booleans.has("non-interactive")) {
      writeError(`install needs answers for a new node config: ${missingAnswerFlags(questions)}.`);
      writeError("Pass them as flags (with --non-interactive for agents), or run install in a terminal for the interactive setup.");
      return 1;
    }
    answers = await promptForInstall(plan, answers, deps.prompt ?? defaultPrompt());
  }

  const resolvedPlan = planInstall(answers, environment);
  answers = { ...answers, dataRoot: resolvedPlan.dataRoot };
  write("orca-pod install");
  write(`  workgroup: ${answers.workgroupId ?? "(existing config)"}`);
  write(`  data root: ${resolvedPlan.dataRoot}`);
  const listenHost = answers.bindHost ?? "::";
  const listen = `${listenHost.includes(":") ? `[${listenHost}]` : listenHost}:${String(answers.port ?? 11811)}`;
  write(`  listen:    ${listen}`);
  write(`  service:   ${resolvedPlan.serviceName} at ${resolvedPlan.unitPath}`);

  if (parsed.booleans.has("dry-run")) {
    write("");
    write(renderUnit(resolvedPlan).trimEnd());
    write("");
    for (const command of resolvedPlan.commands) write(`would run: ${command.join(" ")}`);
    return 0;
  }

  if (!parsed.booleans.has("skip-dsh-check")) {
    const checked = checkDsh(environment.dshBin);
    if (!checked.ok) {
      writeError(`dsh was not found: ${checked.message ?? "unknown error"}`);
      writeError("Install DeepSeek Harness first, or pass --dsh-bin <path>; --skip-dsh-check overrides this check.");
      return 1;
    }
    write(`dsh:       ${checked.version ?? "found"}`);
  }

  const result = await installService(resolvedPlan, answers);
  write(`orca-pod: wrote ${resolvedPlan.unitPath}`);
  if (result.configCreated) write(`orca-pod: created ${resolvedPlan.configPath}`);
  for (const command of result.commands) {
    if (!command.ok) {
      writeError(`command failed: ${command.stderr.trim() || command.stdout.trim()}`);
      writeError("Fix the error, then run the commands from the plan manually.");
      return 1;
    }
  }
  if (answers.noStart === true) {
    write("orca-pod: unit written; start it with:");
    for (const command of resolvedPlan.commands) write(`  ${command.join(" ")}`);
  } else {
    write(`orca-pod: ${resolvedPlan.serviceName} enabled and started`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
