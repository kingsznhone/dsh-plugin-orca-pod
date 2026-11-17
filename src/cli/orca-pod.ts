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
import { parseArgs } from "node:util";

import {
  INSTALL_BIND_HOST,
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
import { CLI_PATH, errorMessage } from "../kernel/index.ts";
import { DEFAULT_PORT } from "../protocol/index.ts";
import { parseSettings } from "../node/index.ts";

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
  --data-root <path>    Node data directory (default: $ORCA_POD_HOME, else
                        $DSH_PROFILE_DIR/orca-pod, else $DSH_HOME/orca-pod, else ~/.dsh/orca-pod)
  --bind-host <addr>    Listen address (default: ::, all interfaces)
  --port <number>       Listen port (default: ${DEFAULT_PORT})
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

const OPTIONS = {
  workgroup: { type: "string" },
  password: { type: "string", short: "p" },
  "data-root": { type: "string" },
  "bind-host": { type: "string" },
  port: { type: "string" },
  endpoint: { type: "string", multiple: true },
  peer: { type: "string", multiple: true },
  "env-file": { type: "string", multiple: true },
  env: { type: "string", multiple: true },
  "display-name": { type: "string" },
  "service-name": { type: "string" },
  "dsh-bin": { type: "string" },
  system: { type: "boolean" },
  "no-start": { type: "boolean" },
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  "skip-dsh-check": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function parseInstallArgs(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
}

type InstallFlags = ReturnType<typeof parseInstallArgs>["values"];

interface ParsedArguments {
  command: string | null;
  values: InstallFlags;
}

/** Options that do not turn install into the flag-driven branch. */
const INTERACTIVE_NEUTRAL = new Set(["dry-run", "help"]);

export function parseArguments(argv: string[]): ParsedArguments {
  const { values, positionals } = parseInstallArgs(argv);
  const [command = null, ...extra] = positionals;
  if (extra.length > 0) throw new Error(`unexpected argument ${extra[0]}`);
  return { command, values };
}

/** True only for `install` (plus `--dry-run`/help), i.e. no setup flags. */
export function isInteractiveInvocation(parsed: ParsedArguments): boolean {
  return Object.keys(parsed.values).every((name) => INTERACTIVE_NEUTRAL.has(name));
}

interface MainDeps {
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
  const { values } = parsed;
  if (values.help === true || parsed.command === null) {
    write(USAGE);
    return 0;
  }
  if (parsed.command !== "install") {
    writeError(`unknown command ${parsed.command}\n\n${USAGE}`);
    return 2;
  }

  const options: InstallOptions = {
    system: values.system === true,
    noStart: values["no-start"] === true,
    force: values.force === true,
    serviceName: values["service-name"] ?? "orca-pod",
    envFiles: values["env-file"] ?? [],
    environment: values.env ?? [],
    node: parseSettings({
      workgroup_id: values.workgroup,
      workgroup_password: values.password,
      display_name: values["display-name"],
      data_root: values["data-root"],
      bind_host: values["bind-host"] ?? INSTALL_BIND_HOST,
      port: values.port === undefined ? undefined : Number(values.port),
      endpoints: values.endpoint,
      peers: values.peer,
    }),
  };
  const dshBin = values["dsh-bin"];
  const environment = resolveEnvironment({
    ...(dshBin === undefined ? {} : { dshBin }),
    packageEntry: CLI_PATH,
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
        writeError(
          "Pass them as flags (for example --workgroup lab --password 'secret'); running bare `orca-pod install` would ask interactively.",
        );
      } else {
        writeError(
          "The interactive setup needs a terminal; pass the answers as flags (for example --workgroup lab --password 'secret').",
        );
      }
      return 1;
    }
    answers = await promptForInstall(plan, answers, deps.prompt ?? defaultPrompt());
  }

  const resolvedPlan = planInstall(answers, environment);
  write("orca-pod install");
  write(`  workgroup: ${answers.node.workgroup_id ?? "(existing config)"}`);
  write(`  data root: ${resolvedPlan.dataRoot}`);
  const { bind_host: listenHost, port: listenPort } = answers.node;
  const listen = `${listenHost.includes(":") ? `[${listenHost}]` : listenHost}:${listenPort}`;
  write(`  listen:    ${listen}`);
  write(`  service:   ${resolvedPlan.serviceName} at ${resolvedPlan.unitPath}`);
  if (resolvedPlan.envFiles.length > 0) write(`  env files: ${resolvedPlan.envFiles.join(", ")}`);
  if (resolvedPlan.environment.length > 0) write(`  env:       ${resolvedPlan.environment.join(" ")}`);

  if (values["dry-run"] === true) {
    write("");
    write(renderUnit(resolvedPlan).trimEnd());
    write("");
    for (const command of resolvedPlan.commands) write(`would run: ${command.join(" ")}`);
    return 0;
  }

  if (values["skip-dsh-check"] !== true) {
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
  if (answers.noStart) {
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
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
}
