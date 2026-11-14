#!/usr/bin/env node
/**
 * `orca-pod <command>` launcher.
 *
 * Today there is one command: `install`, which registers a long-lived host node
 * (or a `dsh web` instance with the plugin) as a systemd service. The planning
 * and rendering live in `src/install.ts`; this file is argument parsing and
 * console output only.
 */

import { fileURLToPath } from "node:url";

import {
  checkDsh,
  installService,
  planInstall,
  renderUnit,
  resolveEnvironment,
  type InstallMode,
  type InstallOptions,
} from "./install.ts";

const USAGE = `Usage: orca-pod install [options]

Register an orca-pod host as a systemd service on Linux. The host mode
(recommended) runs \`orca-node serve\` directly; the web mode runs \`dsh web\`
with the orca-pod plugin installed in the web profile.

Options:
  --mode host|web       Launch shape (default: host)
  --workgroup <id>      Workgroup id; required to create a new host config
  --password <secret>   Workgroup password; required to create a new host config
  --data-root <path>    Node data directory (default: ~/.orca-pod)
  --port <number>       Listen port for the node (host mode, default: 11811)
  --endpoint <url>      Advertised endpoint; repeatable
  --display-name <name> Human-readable node name
  --service-name <name> systemd unit name (default: orca-pod-host|-web)
  --dsh-bin <path>      dsh executable (default: dsh on PATH)
  --system              Install a system-wide unit under /etc/systemd/system
  --no-start            Write the unit but do not enable/start it
  --force               Rewrite an existing unit and node config
  --dry-run             Print the unit and commands without writing anything
  --skip-dsh-check      Do not require \`dsh --version\` to succeed
  -h, --help            Show this help

Examples:
  sudo orca-pod install --workgroup lab --password '...' --mode host
  npx orca-pod install --workgroup lab --password '...' --endpoint https://node.example.com:11811
  orca-pod install --mode web --dry-run
`;

interface ParsedArguments {
  command: string | null;
  values: Map<string, string[]>;
  booleans: Set<string>;
}

const VALUE_FLAGS = new Set([
  "mode",
  "workgroup",
  "password",
  "data-root",
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
  "skip-dsh-check",
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

function modeFlag(parsed: ParsedArguments): InstallMode {
  const raw = first(parsed, "mode") ?? "host";
  if (raw !== "host" && raw !== "web") throw new Error("--mode must be host or web");
  return raw;
}

function printPlan(plan: ReturnType<typeof planInstall>, unit: string): void {
  console.log(`mode:      ${plan.mode}`);
  console.log(`service:   ${plan.serviceName}`);
  console.log(`unit:      ${plan.unitPath}`);
  if (plan.mode === "host") console.log(`config:    ${plan.configPath}`);
  console.log(`exec:      ${plan.execStart.join(" ")}`);
  console.log("");
  console.log(unit.trimEnd());
  console.log("");
  for (const command of plan.commands) console.log(`would run: ${command.join(" ")}`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed.booleans.has("help") || parsed.command === null) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.command !== "install") {
    console.error(`unknown command ${parsed.command}\n`);
    console.error(USAGE);
    return 2;
  }

  const mode = modeFlag(parsed);
  const dataRoot = first(parsed, "data-root");
  const options: InstallOptions = {
    mode,
    system: parsed.booleans.has("system"),
    noStart: parsed.booleans.has("no-start"),
    force: parsed.booleans.has("force"),
    ...(dataRoot === undefined ? {} : { dataRoot }),
    ...(first(parsed, "service-name") === undefined ? {} : { serviceName: first(parsed, "service-name")! }),
    ...(first(parsed, "workgroup") === undefined ? {} : { workgroupId: first(parsed, "workgroup")! }),
    ...(first(parsed, "password") === undefined ? {} : { password: first(parsed, "password")! }),
    ...(first(parsed, "display-name") === undefined ? {} : { displayName: first(parsed, "display-name")! }),
    ...(numberFlag(parsed, "port") === undefined ? {} : { port: numberFlag(parsed, "port")! }),
    ...(parsed.values.get("endpoint") === undefined ? {} : { endpoints: [...parsed.values.get("endpoint")!] }),
  };
  const environment = resolveEnvironment({
    ...(first(parsed, "dsh-bin") === undefined ? {} : { dshBin: first(parsed, "dsh-bin")! }),
    packageEntry: fileURLToPath(new URL("./cli.ts", import.meta.url)),
  });
  const plan = planInstall(options, environment);
  const unit = renderUnit(plan);

  console.log(`orca-pod install (${mode} mode)`);
  if (parsed.booleans.has("dry-run")) {
    printPlan(plan, unit);
    return 0;
  }

  if (!parsed.booleans.has("skip-dsh-check")) {
    const checked = checkDsh(environment.dshBin);
    if (!checked.ok) {
      console.error(`dsh was not found: ${checked.message ?? "unknown error"}`);
      console.error("Install DeepSeek Harness first, or pass --dsh-bin <path>; --skip-dsh-check overrides this check.");
      return 1;
    }
    console.log(`dsh:       ${checked.version ?? "found"}`);
  }

  const result = await installService(plan, options);
  console.log(`orca-pod: wrote ${plan.unitPath}`);
  if (result.configCreated) console.log(`orca-pod: created ${plan.configPath}`);
  for (const command of result.commands) {
    if (!command.ok) {
      console.error(`command failed: ${command.stderr.trim() || command.stdout.trim()}`);
      console.error("Fix the error, then run the commands from the plan manually.");
      return 1;
    }
  }
  if (options.noStart === true) {
    console.log("orca-pod: unit written; start it with:");
    for (const command of plan.commands) console.log(`  ${command.join(" ")}`);
  } else {
    console.log(`orca-pod: ${plan.serviceName} enabled and started`);
    if (plan.mode === "web") {
      console.log("orca-pod: install the plugin into the web profile with `dsh plugin add <path> --profile web`");
    }
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
