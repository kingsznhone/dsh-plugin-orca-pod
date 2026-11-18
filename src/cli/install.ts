/**
 * `orca-pod install` — register a long-lived host node as a systemd service.
 *
 * The install target is always the orca-pod host listener (`orca-node serve`):
 * it needs no browser UI, and tasks are dispatched over A2A and executed by the
 * local `dsh` CLI. Users who want the web panel install DeepSeek Harness and add
 * the plugin from its web UI instead; that path is not this command's job.
 *
 * Planning, prompting and unit rendering are pure so the tests never need
 * systemd or a terminal; the CLI wrapper (`src/cli/orca-pod.ts`) performs the writes
 * and owns the interactive readline session.
 */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { configPath, createOrcaNodeConfig, defaultDataRoot, saveConfig } from "../node/config.ts";
import { parseSettings, type Settings } from "../node/settings.ts";
import { bindChoices } from "../core/net.ts";
import { errorMessage } from "../core/errors.ts";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { runNativeCommand, type NativeCommandRunner } from "@deepseek-ai/dsh-native-command";

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

export interface InstallPlan {
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

/** One command's outcome, as the install reports it. */
interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** The setting each install question fills in. */
const ANSWER_FIELD = {
  workgroup: "workgroup_id",
  password: "workgroup_password",
  "bind-host": "bind_host",
  port: "port",
} as const;

/** The answers an install can ask for, named by the flag that supplies them. */
export type AnswerOption = keyof typeof ANSWER_FIELD;

/** One question an interactive install can ask for a value it cannot infer. */
export interface PromptQuestion {
  option: AnswerOption;
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
    // DSH's environment-name grammar: the one its credential references use.
    const separator = assignment.indexOf("=");
    if (separator <= 0 || !isCredentialRefName(assignment.slice(0, separator))) {
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

/** Run one command through DSH's no-shell runner; it rejects on a non-zero exit, carrying the captured output. */
async function runCommand(run: NativeCommandRunner, command: string, args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await run(command, args, new AbortController().signal, "hidden");
    return { ok: true, stdout, stderr };
  } catch (error) {
    const output = error as { stdout?: unknown; stderr?: unknown };
    const stderr = typeof output.stderr === "string" ? output.stderr : "";
    return {
      ok: false,
      stdout: typeof output.stdout === "string" ? output.stdout : "",
      stderr: stderr.trim() === "" ? errorMessage(error) : stderr,
    };
  }
}

/** What looking for `dsh` found: its version, or why it could not be run. */
export type DshCheck = { ok: true; version: string } | { ok: false; message: string };

/** Check that `dsh` exists and print its version; tasks need it at runtime. */
export async function checkDsh(dshBin: string, run: NativeCommandRunner = runNativeCommand): Promise<DshCheck> {
  const result = await runCommand(run, dshBin, ["--version"]);
  if (!result.ok)
    return { ok: false, message: `${dshBin} --version failed: ${result.stderr.trim() || result.stdout.trim()}` };
  return { ok: true, version: result.stdout.trim() };
}

/** True when the install would write a fresh node config (or overwrite one). */
export function needsNodeConfig(plan: InstallPlan, options: InstallOptions): boolean {
  return options.force || !existsSync(plan.configPath);
}

/**
 * Questions that must have an answer before a fresh config can be written.
 * Optional values (listen address, port) are only asked in interactive mode; a
 * non-interactive install simply keeps their defaults.
 */
export function installQuestions(plan: InstallPlan, options: InstallOptions): PromptQuestion[] {
  if (!needsNodeConfig(plan, options)) return [];
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

/** Fill the answers from the interactive prompts into a fresh options object. */
export async function promptForInstall(
  plan: InstallPlan,
  options: InstallOptions,
  prompt: PromptFn,
): Promise<InstallOptions> {
  const answers: Record<string, unknown> = {};
  const questions = [...installQuestions(plan, options), ...optionalInstallQuestions(options)];
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
export async function ensureNodeConfig(plan: InstallPlan, options: InstallOptions): Promise<{ created: boolean }> {
  if (!needsNodeConfig(plan, options)) return { created: false };
  if (!options.node.workgroup_id || !options.node.workgroup_password) {
    throw new Error(
      "install needs a workgroup id and password to create the node config (pass --workgroup and --password, or answer the interactive prompts)",
    );
  }
  await mkdir(plan.dataRoot, { recursive: true, mode: 0o700 });
  await saveConfig(
    plan.configPath,
    await createOrcaNodeConfig({ ...options.node, data_root: plan.dataRoot, executor: "acp" }),
  );
  return { created: true };
}

interface InstallResult {
  plan: InstallPlan;
  unit: string;
  configCreated: boolean;
  commands: CommandResult[];
}

/** Write the unit and activate it with `run`; `noStart` stops after the write. */
export async function installService(
  plan: InstallPlan,
  options: InstallOptions,
  run: NativeCommandRunner = runNativeCommand,
): Promise<InstallResult> {
  await mkdir(dirname(plan.unitPath), { recursive: true });
  const unit = renderUnit(plan);
  // The unit can carry `--env` values: owner-only, and replaced in one step.
  await writeFileAtomic(plan.unitPath, unit, { mode: 0o600 });
  const configCreated = (await ensureNodeConfig(plan, options)).created;
  const commands: CommandResult[] = [];
  if (!options.noStart) {
    for (const [program = "", ...args] of plan.commands) commands.push(await runCommand(run, program, args));
  }
  return { plan, unit, configCreated, commands };
}
