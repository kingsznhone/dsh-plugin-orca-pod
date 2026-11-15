#!/usr/bin/env node
/**
 * `orca-pod <command>` launcher.
 *
 * Today there is one command: `install`, which registers the host listener
 * (`orca-node serve`) as a systemd service. Users who want the web panel install
 * DeepSeek Harness themselves and add the plugin from its web UI; this command
 * deliberately has no `web` mode.
 *
 * Invocation has two shapes:
 *  - `orca-pod install` or `orca-pod install --dry-run`: an interactive setup
 *    asks for the workgroup id, password, listen address and port;
 *  - any other option makes it fully flag-driven: missing required answers fail
 *    immediately, which is what an agent installing over SSH needs.
 *
 * Planning and rendering live in `src/install.ts`; this file owns argument
 * parsing, the interactive readline session and console output.
 */

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

Run \`orca-pod install\` (or \`orca-pod install --dry-run\`) in a terminal for the
interactive setup. Passing any other option makes install fully flag-driven and
it never prompts: pass every required answer, which is what an agent installing
over SSH should do.

Options:
  -p, --password <secret>
                        Workgroup password
  --workgroup <id>      Workgroup id
  --data-root <path>    Node data directory (default: ~/.orca-pod)
  --bind-host <addr>    Listen address (default: ::, all interfaces)
  --port <number>       Listen port (default: 11811)
  --endpoint <url>      Advertised endpoint; repeatable
  --peer <url>          Peer to join at startup; repeatable
  --env-file <path>     Read environment variables from this file (systemd EnvironmentFile);
                        repeatable, for example a file holding DEEPSEEK_API_KEY
  --env <KEY=VALUE>     Extra environment assignment for the unit; repeatable, for example
                        --env PATH=/usr/local/bin:/usr/bin:/bin
  --display-name <name> Human-readable node name
  --service-name <name> systemd unit name (default: orca-pod)
  --system              Install a system-wide unit under /etc/systemd/system
  --no-start            Write the unit but do not enable/start it
  --force               Rewrite an existing unit and node config
  --dry-run             Print the plan without writing anything
  --skip-dsh-check      Do not require \`dsh --version\` to succeed
  -h, --help            Show this help

Examples:
  npx orca-pod install
  npx orca-pod install --workgroup lab --password 'secret'
  sudo npx orca-pod install --system --workgroup lab --password 'secret'
  npx orca-pod install --dry-run --workgroup lab --password 'secret'
`;

interface ParsedArguments {
  command: string | null;
  values: Map<string, string[]>;
  booleans: Set<string>;
  /** Options the caller supplied, excluding `--dry-run` and help. */
  explicit: Set<string>;
}

const VALUE_FLAGS = new Set([
  "workgroup",
  "password",
  "data-root",
  "bind-host",
  "port",
  "endpoint",
  "peer",
  "env-file",
  "env",
  "display-name",
  "service-name",
  "dsh-bin",
]);

const BOOLEAN_FLAGS = new Set([
  "system",
  "no-start",
  "force",
  "dry-run",
  "skip-dsh-check",
  "help",
]);

/** Options that do not turn install into the flag-driven branch. */
const INTERACTIVE_NEUTRAL = new Set(["dry-run", "help"]);

export function parseArguments(argv: string[]): ParsedArguments {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const explicit = new Set<string>();
  let command: string | null = null;
  const record = (name: string): void => {
    if (!INTERACTIVE_NEUTRAL.has(name)) explicit.add(name);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") {
      booleans.add("help");
      continue;
    }
    if (token === "-p") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("-p needs a value");
      const list = values.get("password") ?? [];
      list.push(value);
      values.set("password", list);
      record("password");
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        booleans.add(name);
        record(name);
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
        record(name);
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
  return { command, values, booleans, explicit };
}

/** True only for `install` (plus `--dry-run`/help), i.e. no setup flags. */
export function isInteractiveInvocation(parsed: ParsedArguments): boolean {
  return parsed.explicit.size === 0;
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
  /** Defaults to a readline session on stdin/stdout. */
  prompt?: PromptFn;
  /** Defaults to `process.stdin.isTTY`; false never prompts (SSH without -t). */
  canPrompt?: boolean;
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
    else if (question.option === "password") flags.push("--password");
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

  const dataRoot = first(parsed, "data-root");
  const options: InstallOptions = {
    system: parsed.booleans.has("system"),
    noStart: parsed.booleans.has("no-start"),
    force: parsed.booleans.has("force"),
    ...(dataRoot === undefined ? {} : { dataRoot }),
    ...(first(parsed, "service-name") === undefined ? {} : { serviceName: first(parsed, "service-name")! }),
    ...(first(parsed, "workgroup") === undefined ? {} : { workgroupId: first(parsed, "workgroup")! }),
    ...(first(parsed, "password") === undefined ? {} : { password: first(parsed, "password")! }),
    ...(first(parsed, "display-name") === undefined ? {} : { displayName: first(parsed, "display-name")! }),
    ...(first(parsed, "bind-host") === undefined ? {} : { bindHost: first(parsed, "bind-host")! }),
    ...(numberFlag(parsed, "port") === undefined ? {} : { port: numberFlag(parsed, "port")! }),
    ...(parsed.values.get("endpoint") === undefined ? {} : { endpoints: [...parsed.values.get("endpoint")!] }),
    ...(parsed.values.get("peer") === undefined ? {} : { peers: [...parsed.values.get("peer")!] }),
    ...(parsed.values.get("env-file") === undefined ? {} : { envFiles: [...parsed.values.get("env-file")!] }),
    ...(parsed.values.get("env") === undefined ? {} : { environment: [...parsed.values.get("env")!] }),
  };
  const environment = resolveEnvironment({
    ...(first(parsed, "dsh-bin") === undefined ? {} : { dshBin: first(parsed, "dsh-bin")! }),
    packageEntry: fileURLToPath(new URL("./cli.ts", import.meta.url)),
    ...deps.environment,
  });
  const plan = planInstall(options, environment);

  let answers: InstallOptions = options;
  const interactive = isInteractiveInvocation(parsed);
  const canPrompt = deps.canPrompt ?? (deps.prompt !== undefined || process.stdin.isTTY === true);
  const questions = installQuestions(plan, answers);
  if (questions.length > 0) {
    if (!interactive || !canPrompt) {
      writeError(`install needs answers for a new node config: ${missingAnswerFlags(questions)}.`);
      if (!interactive) {
        writeError("Pass them as flags (for example --workgroup lab --password 'secret'); running bare `orca-pod install` would ask interactively.");
      } else {
        writeError("The interactive setup needs a terminal; pass the answers as flags (for example --workgroup lab --password 'secret').");
      }
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
  if (resolvedPlan.envFiles.length > 0) write(`  env files: ${resolvedPlan.envFiles.join(", ")}`);
  if (resolvedPlan.environment.length > 0) write(`  env:       ${resolvedPlan.environment.join(" ")}`);

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
  if (!resolvedPlan.system) {
    write(
      "orca-pod: note: on a headless server run `loginctl enable-linger $USER` so this user service keeps running after logout.",
    );
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
