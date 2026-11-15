/**
 * `orca-pod install` — register a long-lived host node as a systemd service.
 *
 * The install target is always the orca-pod host listener (`orca-node serve`):
 * it needs no browser UI, and tasks are dispatched over A2A and executed by the
 * local `dsh` CLI. Users who want the web panel install DeepSeek Harness and add
 * the plugin from its web UI instead; that path is not this command's job.
 *
 * Planning, prompting and unit rendering are pure so the tests never need
 * systemd or a terminal; the CLI wrapper (`src/orca-pod.ts`) performs the writes
 * and owns the interactive readline session.
 */

import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { configPath, createOrcaNodeConfig, saveConfig } from "./config.ts";

export interface InstallOptions {
  /** Install a system-wide unit instead of a user unit. */
  system?: boolean;
  /** Defaults to `orca-pod`. */
  serviceName?: string;
  dataRoot?: string;
  port?: number;
  /** Listen address written into a new node config (default `::`). */
  bindHost?: string;
  workgroupId?: string;
  password?: string;
  endpoints?: string[];
  displayName?: string;
  /** Peers the service unit joins on startup (`serve --peer ...`). */
  peers?: string[];
  /** Path to the `dsh` executable; defaults to `dsh` on PATH. */
  dshBin?: string;
  /** Path to the `node` executable used by the unit. */
  nodeBin?: string;
  /** Entry point of the CLI shipped by this package. */
  packageEntry?: string;
  /** Remove an existing unit before writing (does not delete config). */
  force?: boolean;
  /** Do not run `systemctl enable --now` (still writes the unit). */
  noStart?: boolean;
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
  /** `systemctl` invocations to activate the unit. */
  commands: string[][];
}

export interface CommandResult {
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
}

export type PromptFn = (question: PromptQuestion) => Promise<string>;

export function resolveEnvironment(overrides: Partial<InstallEnvironment> = {}): InstallEnvironment {
  return {
    home: overrides.home ?? process.env["HOME"] ?? homedir(),
    nodeBin: overrides.nodeBin ?? process.execPath,
    packageEntry: overrides.packageEntry ?? "",
    dshBin: overrides.dshBin ?? "dsh",
  };
}

export function planInstall(options: InstallOptions, env: InstallEnvironment): InstallPlan {
  const system = options.system === true;
  const serviceName = options.serviceName ?? "orca-pod";
  const dataRoot = options.dataRoot ?? join(env.home, ".orca-pod");
  const unitDir = system ? "/etc/systemd/system" : join(env.home, ".config", "systemd", "user");
  const unitPath = join(unitDir, `${serviceName}.service`);
  const config = configPath(dataRoot);
  const systemctl = system ? ["systemctl"] : ["systemctl", "--user"];
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
      ...(options.peers ?? []).flatMap((peer) => ["--peer", peer]),
    ],
    commands: [
      [...systemctl, "daemon-reload"],
      [...systemctl, "enable", "--now", serviceName],
    ],
  };
}

/** systemd splits ExecStart itself, so quote arguments that would confuse it. */
export function systemdQuote(argument: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(argument) ? argument : `"${argument.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

export function runCommand(command: string, args: string[]): CommandResult {
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
    if (!result.ok) return { ok: false, message: `${dshBin} --version failed: ${result.stderr.trim() || result.stdout.trim()}` };
    return { ok: true, version: result.stdout.trim() };
  } catch (error) {
    return { ok: false, message: `could not run ${dshBin}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface ConfigDeps {
  exists?: (path: string) => boolean;
  save?: (path: string, config: ReturnType<typeof createOrcaNodeConfig>) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
}

/** True when the install would write a fresh node config (or overwrite one). */
export function needsNodeConfig(
  plan: InstallPlan,
  options: InstallOptions,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return options.force === true || !exists(plan.configPath);
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
  if (options.workgroupId === undefined || options.workgroupId === "") {
    questions.push({ option: "workgroup", message: "Workgroup id" });
  }
  if (options.password === undefined || options.password === "") {
    questions.push({ option: "password", message: "Workgroup password", secret: true });
  }
  return questions;
}

/** Extra prompts shown only in the interactive setup; answers have defaults. */
export function optionalInstallQuestions(options: InstallOptions): PromptQuestion[] {
  return [
    { option: "bind-host", message: "Listen address", default: options.bindHost ?? "::" },
    { option: "port", message: "Listen port", default: String(options.port ?? 11811) },
  ];
}

/** Fill the answers from the interactive prompts into a fresh options object. */
export async function promptForInstall(
  plan: InstallPlan,
  options: InstallOptions,
  prompt: PromptFn,
  exists: (path: string) => boolean = existsSync,
): Promise<InstallOptions> {
  const next: InstallOptions = { ...options };
  const questions = [...installQuestions(plan, options, exists), ...optionalInstallQuestions(options)];
  for (const question of questions) {
    const raw = (await prompt(question)).trim();
    const value = raw === "" ? (question.default ?? "") : raw;
    if (value === "") throw new Error(`${question.message} is required`);
    switch (question.option) {
      case "workgroup":
        next.workgroupId = value;
        break;
      case "password":
        next.password = value;
        break;
      case "bind-host":
        next.bindHost = value;
        break;
      case "port": {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Listen port must be an integer between 0 and 65535");
        next.port = port;
        break;
      }
    }
  }
  return next;
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
  if (exists(plan.configPath) && options.force !== true) return { created: false };
  if (!options.workgroupId || !options.password) {
    throw new Error(
      "install needs a workgroup id and password to create the node config (pass --workgroup and --password, or answer the interactive prompts)",
    );
  }
  const config = createOrcaNodeConfig({
    workgroupId: options.workgroupId,
    password: options.password,
    dataRoot: plan.dataRoot,
    host: options.bindHost ?? "::",
    port: options.port ?? 11811,
    ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    executor: "acp",
  });
  await mkdir(plan.dataRoot, { recursive: true, mode: 0o700 });
  const save = deps.save ?? saveConfig;
  await save(plan.configPath, config);
  try {
    await (deps.chmod ?? chmod)(plan.configPath, 0o600);
  } catch {
    // Windows has no POSIX modes; the file still lives under the data root.
  }
  return { created: true };
}

export interface InstallDeps extends ConfigDeps {
  run?: CommandRunner;
  mkdir?: (path: string, options?: { recursive?: boolean; mode?: number }) => Promise<unknown>;
  writeFile?: (path: string, text: string) => Promise<void>;
}

export interface InstallResult {
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
  if (options.noStart !== true) {
    const run = deps.run ?? runCommand;
    for (const command of plan.commands) {
      commands.push(run(command[0]!, command.slice(1)));
    }
  }
  return { plan, unit, configCreated, commands };
}
