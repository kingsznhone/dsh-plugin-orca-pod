/**
 * `orca-pod install` — register a long-lived host node as a systemd service.
 *
 * The install target is always the orca-pod host listener (`orca-node serve`):
 * it needs no browser UI, and tasks are dispatched over A2A and executed by the
 * local `dsh` CLI. Users who want the web panel install DeepSeek Harness and add
 * the plugin from its web UI instead; that path is not this command's job.
 *
 * Planning, prompting and unit rendering are pure so the tests never need
 * systemd or a terminal; the CLI wrapper (`src/orca_pod.ts`) performs the writes
 * and owns the interactive readline session.
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { configPath, createOrcaNodeConfig, defaultDataRoot, saveConfig } from "./config.ts";
import { bindChoices } from "./net.ts";
import { parseSettings, type Settings } from "./settings.ts";
import { errorMessage } from "./errors.ts";

/** A service listens on all interfaces unless told otherwise (the plugin defaults to loopback). */
export const INSTALL_BIND_HOST = "::";

export interface InstallOptions {
  /** Install a system-wide unit instead of a user unit. */
  system: boolean;
  serviceName: string;
  /** Files systemd reads with `EnvironmentFile=` (for example an API key file). */
  envFiles: string[];
  /** `KEY=VALUE` assignments written as `Environment=` lines. */
  environment: string[];
  /** Remove an existing unit before writing (does not delete config). */
  force: boolean;
  /** Do not run `systemctl enable --now` (still writes the unit). */
  noStart: boolean;
  /** Settings of a fresh node config; `peers` are what the unit joins on startup (`serve --peer ...`). */
  node: Settings;
}

export interface InstallEnvironment {
  home: string;
  nodeBin: string;
  packageEntry: string;
  dshBin: string;
}

interface InstallPlan {
  system: boolean;
  serviceName: string;
  unitPath: string;
  dataRoot: string;
  configPath: string;
  /** Command that the unit runs, arg by arg. */
  execStart: string[];
  /** `EnvironmentFile=` entries for the unit. */
  envFiles: string[];
  /** `Environment=` assignments for the unit, already validated as KEY=VALUE. */
  environment: string[];
  /** `systemctl` invocations to activate the unit. */
  commands: string[][];
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

/** One question an interactive install can ask for a value it cannot infer. */
export interface PromptQuestion {
  option: "workgroup" | "password" | "bind-host" | "port";
  message: string;
  default?: string;
  secret?: boolean;
  /** Suggested answers the interactive prompt can print (bind-host interface list). */
  choices?: string[];
}

export type PromptFn = (question: PromptQuestion) => Promise<string>;

export function resolveEnvironment(overrides: Partial<InstallEnvironment> = {}): InstallEnvironment {
  return {
    home: overrides.home ?? process.env.HOME ?? homedir(),
    nodeBin: overrides.nodeBin ?? process.execPath,
    packageEntry: overrides.packageEntry ?? "",
    dshBin: overrides.dshBin ?? "dsh",
  };
}

export function planInstall(options: InstallOptions, env: InstallEnvironment): InstallPlan {
  const { system, serviceName } = options;
  const dataRoot = options.node.data_root ?? defaultDataRoot();
  const unitDir = system ? "/etc/systemd/system" : join(env.home, ".config", "systemd", "user");
  const unitPath = join(unitDir, `${serviceName}.service`);
  const config = configPath(dataRoot);
  const systemctl = system ? ["systemctl"] : ["systemctl", "--user"];
  const { envFiles, environment } = options;
  for (const file of envFiles) {
    if (file === "") throw new Error("--env-file needs a non-empty path");
  }
  for (const assignment of environment) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(assignment)) {
      throw new Error(`--env must be KEY=VALUE with an environment-style name, got ${JSON.stringify(assignment)}`);
    }
  }
  return {
    system,
    serviceName,
    unitPath,
    dataRoot,
    configPath: config,
    execStart: [
      env.nodeBin,
      env.packageEntry,
      "serve",
      "--config",
      config,
      ...options.node.peers.flatMap((peer) => ["--peer", peer]),
    ],
    envFiles,
    environment,
    commands: [
      [...systemctl, "daemon-reload"],
      [...systemctl, "enable", "--now", serviceName],
    ],
  };
}

/** systemd splits ExecStart itself, so quote arguments that would confuse it. */
export function systemdQuote(argument: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(argument)
    ? argument
    : `"${argument.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Render one `Environment=` assignment, quoting only the value when needed. */
function environmentAssignment(assignment: string): string {
  const index = assignment.indexOf("=");
  const name = assignment.slice(0, index);
  const value = assignment.slice(index + 1);
  return `${name}=${systemdQuote(value)}`;
}

export function renderUnit(plan: InstallPlan, description = "orca-pod host node"): string {
  const lines = [
    "[Unit]",
    `Description=${description}`,
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${plan.dataRoot}`,
    `ExecStart=${plan.execStart.map(systemdQuote).join(" ")}`,
    "Environment=NODE_ENV=production",
    ...plan.envFiles.map((file) => `EnvironmentFile=${systemdQuote(file)}`),
    ...plan.environment.map((assignment) => `Environment=${environmentAssignment(assignment)}`),
    "Restart=on-failure",
    "RestartSec=5",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=20",
    "",
    "[Install]",
    `WantedBy=${plan.system ? "multi-user.target" : "default.target"}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Check that `dsh` exists and print its version; tasks need it at runtime. */
export function checkDsh(
  dshBin: string,
  run: CommandRunner = runCommand,
): { ok: boolean; version?: string; message?: string } {
  try {
    const result = run(dshBin, ["--version"]);
    if (!result.ok)
      return { ok: false, message: `${dshBin} --version failed: ${result.stderr.trim() || result.stdout.trim()}` };
    return { ok: true, version: result.stdout.trim() };
  } catch (error) {
    return { ok: false, message: `could not run ${dshBin}: ${errorMessage(error)}` };
  }
}

interface ConfigDeps {
  exists?: (path: string) => boolean;
}

/** True when the install would write a fresh node config (or overwrite one). */
export function needsNodeConfig(
  plan: InstallPlan,
  options: InstallOptions,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return options.force || !exists(plan.configPath);
}

/**
 * Questions that must have an answer before a fresh config can be written.
 * Optional values (listen address, port) are only asked in interactive mode; a
 * non-interactive install simply keeps their defaults.
 */
export function installQuestions(
  plan: InstallPlan,
  options: InstallOptions,
  exists: (path: string) => boolean = existsSync,
): PromptQuestion[] {
  if (!needsNodeConfig(plan, options, exists)) return [];
  const questions: PromptQuestion[] = [];
  if (!options.node.workgroup_id) {
    questions.push({ option: "workgroup", message: "Workgroup id" });
  }
  if (!options.node.workgroup_password) {
    questions.push({ option: "password", message: "Workgroup password", secret: true });
  }
  return questions;
}

/** Extra prompts shown only in the interactive setup; answers have defaults. */
export function optionalInstallQuestions(options: InstallOptions): PromptQuestion[] {
  const { port } = options.node;
  const choices = bindChoices(port);
  return [
    {
      option: "bind-host",
      message: "Listen address (127.0.0.1 = local only, :: = all interfaces)",
      default: options.node.bind_host,
      choices,
    },
    { option: "port", message: "Listen port", default: String(port) },
  ];
}

const ANSWER_FIELD = {
  workgroup: "workgroup_id",
  password: "workgroup_password",
  "bind-host": "bind_host",
  port: "port",
} as const;

/** Fill the answers from the interactive prompts into a fresh options object. */
export async function promptForInstall(
  plan: InstallPlan,
  options: InstallOptions,
  prompt: PromptFn,
  exists: (path: string) => boolean = existsSync,
): Promise<InstallOptions> {
  const answers: Record<string, unknown> = {};
  const questions = [...installQuestions(plan, options, exists), ...optionalInstallQuestions(options)];
  for (const question of questions) {
    const asked =
      question.choices === undefined || question.choices.length === 0
        ? question
        : { ...question, message: `${question.message} (${question.choices.join(", ")})` };
    const raw = (await prompt(asked)).trim();
    const value = raw === "" ? (question.default ?? "") : raw;
    if (value === "") throw new Error(`${question.message} is required`);
    answers[ANSWER_FIELD[question.option]] = question.option === "port" ? Number(value) : value;
  }
  return { ...options, node: parseSettings({ ...options.node, ...answers }) };
}

/**
 * Create `<data_root>/config.json` on first install. The Ed25519 identity is
 * created once per data root, so re-running install keeps the orca node id.
 */
export async function ensureNodeConfig(
  plan: InstallPlan,
  options: InstallOptions,
  deps: ConfigDeps = {},
): Promise<{ created: boolean }> {
  const exists = deps.exists ?? existsSync;
  if (exists(plan.configPath) && !options.force) return { created: false };
  if (!options.node.workgroup_id || !options.node.workgroup_password) {
    throw new Error(
      "install needs a workgroup id and password to create the node config (pass --workgroup and --password, or answer the interactive prompts)",
    );
  }
  await mkdir(plan.dataRoot, { recursive: true, mode: 0o700 });
  await saveConfig(
    plan.configPath,
    createOrcaNodeConfig({ ...options.node, data_root: plan.dataRoot, executor: "acp" }),
  );
  return { created: true };
}

interface InstallDeps extends ConfigDeps {
  run?: CommandRunner;
  mkdir?: (path: string, options?: { recursive?: boolean; mode?: number }) => Promise<unknown>;
  writeFile?: (path: string, text: string) => Promise<void>;
}

interface InstallResult {
  plan: InstallPlan;
  unit: string;
  configCreated: boolean;
  commands: CommandResult[];
}

/** Write the unit and activate it; `noStart` stops after the write. */
export async function installService(
  plan: InstallPlan,
  options: InstallOptions,
  deps: InstallDeps = {},
): Promise<InstallResult> {
  const mkdirp = deps.mkdir ?? mkdir;
  const write = deps.writeFile ?? writeFile;
  await mkdirp(dirname(plan.unitPath), { recursive: true });
  const unit = renderUnit(plan);
  await write(plan.unitPath, unit);
  const configCreated = (await ensureNodeConfig(plan, options, deps)).created;
  const commands: CommandResult[] = [];
  if (!options.noStart) {
    const run = deps.run ?? runCommand;
    for (const [program = "", ...args] of plan.commands) commands.push(run(program, args));
  }
  return { plan, unit, configCreated, commands };
}
