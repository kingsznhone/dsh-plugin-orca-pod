#!/usr/bin/env node
import process from "node:process";
import { randomUUID } from "node:crypto";

import { configPath, defaultDataRoot, loadConfig, workgroupKey, type OrcaNodeConfig } from "./config.ts";
import { buildAuthHeader } from "./crypto.ts";
import { createOrcaNode, createPersistentStorage } from "./index.ts";
import type { A2AMessage, MembersResponse, TaskRelay, TaskView } from "./protocol.ts";
import { permissionRequestOf } from "./protocol.ts";

const USAGE = `orca-node

Usage:
  orca-node serve   --config <path>                     start an orca node from a config file
  orca-node send    --peer <url> --text <text|-> [--context <id>] [--json]
  orca-node status  --peer <url> --task <id> [--json]
  orca-node wait    --peer <url> --task <id> [--local-task <this task>] [--timeout <seconds>] [--json]
  orca-node escalate --peer <child> --task <child task> --local-task <this task> [--timeout <s>] [--json]
  orca-node members [--peer <url>] [--json]
  orca-node --help                                      show this help

Common options:
  --config <path>       use a config file instead of <data-root>/config.json
  --data-root <path>    directory holding config.json (default ~/.orca-pod)

Exit codes (wait):
  0 completed    1 failed/canceled    2 still running    3 input-required
  With --local-task, a child permission request is escalated to this task's origin
  automatically; wait keeps going after the decision (3 only if it cannot escalate).

Exit codes (escalate):
  0 approved and this task is working again    1 denied/failed    2 timed out
`;

const TERMINAL = new Set(["completed", "failed", "canceled"]);

function usageError(message: string): never {
  throw new Error(`${message}\n\n${USAGE}`);
}

function parseFlags(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) usageError(`unexpected argument ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

function flag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requireFlag(flags: Map<string, string | true>, name: string): string {
  const value = flag(flags, name);
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function wantsJson(flags: Map<string, string | true>): boolean {
  return flags.get("json") === true;
}

async function loadNodeConfig(flags: Map<string, string | true>): Promise<OrcaNodeConfig> {
  const explicit = flag(flags, "config");
  if (explicit !== undefined) return loadConfig(explicit);
  const dataRoot = flag(flags, "data-root") ?? defaultDataRoot();
  return loadConfig(configPath(dataRoot));
}

function normalizePeer(peer: string): string {
  return /^https?:\/\//i.test(peer) ? peer : `http://${peer}`;
}

function localEndpoint(config: OrcaNodeConfig): string {
  return config.endpoint ?? `http://${config.bind.host}:${config.bind.port}`;
}

async function signedJson<T>(
  config: OrcaNodeConfig,
  peer: string,
  method: string,
  path: string,
  payload?: unknown,
): Promise<T> {
  const url = new URL(path, normalizePeer(peer));
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthHeader({
        key: workgroupKey(config),
        orcaNodeId: config.orca_node_id,
        method,
        path: url.pathname,
        ...(body !== undefined ? { body } : {}),
      }),
    },
    ...(body !== undefined ? { body } : {}),
  });
  const parsed = (await response.json().catch(() => ({}))) as { code?: string; message?: string } & T;
  if (!response.ok || typeof parsed.code === "string") {
    throw new Error(`${normalizePeer(peer)}${path}: ${parsed.code ?? `http_${response.status}`}${parsed.message ? ` (${parsed.message})` : ""}`);
  }
  return parsed;
}

function a2a<T>(config: OrcaNodeConfig, peer: string, method: string, params: unknown): Promise<T> {
  const url = "/a2a";
  const body = JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params });
  const response = fetch(new URL(url, normalizePeer(peer)), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: buildAuthHeader({
        key: workgroupKey(config),
        orcaNodeId: config.orca_node_id,
        method: "POST",
        path: url,
        body,
      }),
    },
    body,
  }).then(async (res) => {
    const parsed = (await res.json().catch(() => ({}))) as {
      result?: T;
      error?: { message?: string; data?: { message?: string } };
    };
    if (!res.ok || parsed.error !== undefined) {
      const code = parsed.error?.message ?? `http_${res.status}`;
      const detail = parsed.error?.data?.message ?? "";
      throw new Error(`${method}: ${code}${detail ? ` (${detail})` : ""}`);
    }
    return parsed.result as T;
  });
  return response;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function statusLine(view: TaskView): string {
  const part = view.status.message?.parts.find((item) => item.kind === "text");
  const text = part !== undefined && part.kind === "text" ? part.text : "";
  return `task ${view.id} ${view.status.state}${view.status.reason ? ` (${view.status.reason})` : ""}${text ? `: ${text}` : ""}`;
}

function printView(view: TaskView, json: boolean): void {
  process.stdout.write(`${json ? JSON.stringify(view, null, 2) : statusLine(view)}\n`);
}

async function serve(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const explicit = requireFlag(flags, "config");
  const config = await loadConfig(explicit);
  const orcaNode = createOrcaNode({ config, storage: createPersistentStorage(config) });
  const { url } = await orcaNode.start();
  process.stdout.write(`orca-node ${orcaNode.orcaNodeId} listening on ${url}\n`);

  const shutdown = (): void => {
    void orcaNode.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function send(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const config = await loadNodeConfig(flags);
  const peer = requireFlag(flags, "peer");
  const raw = requireFlag(flags, "text");
  const text = raw === "-" ? await readStdin() : raw;
  if (text.length === 0) throw new Error("--text must not be empty (pipe text with --text -)");
  const context = flag(flags, "context");
  const metadataRaw = flag(flags, "metadata");
  const metadata = metadataRaw === undefined ? undefined : (JSON.parse(metadataRaw) as Record<string, unknown>);
  const message: A2AMessage = {
    role: "user",
    parts: [{ kind: "text", text }],
    ...(context !== undefined ? { contextId: context } : {}),
  };
  const view = await a2a<TaskView>(config, peer, "message/send", {
    message,
    ...(metadata !== undefined ? { metadata } : {}),
  });
  printView(view, wantsJson(flags));
  return 0;
}

async function status(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const config = await loadNodeConfig(flags);
  const peer = requireFlag(flags, "peer");
  const task = requireFlag(flags, "task");
  const view = await a2a<TaskView>(config, peer, "tasks/get", { id: task });
  printView(view, wantsJson(flags));
  return 0;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Push a child's pending permission request up to the origin of `localTask`
 * (§7.12). Resolves once the local task leaves `input-required`.
 */
async function escalateToOrigin(
  config: OrcaNodeConfig,
  childPeer: string,
  childTask: string,
  localTask: string,
  timeoutS: number,
): Promise<{ state: string; view: TaskView }> {
  const child = await a2a<TaskView>(config, childPeer, "tasks/get", { id: childTask });
  const request = permissionRequestOf(child);
  if (request === null) throw new Error(`task ${childTask} on ${childPeer} is not waiting for permission`);
  const relay: TaskRelay = { peer: normalizePeer(childPeer), task_id: childTask, request };
  const local = localEndpoint(config);
  let view = await a2a<TaskView>(config, local, "tasks/escalate", { taskId: localTask, relay });
  const deadline = Date.now() + timeoutS * 1000;
  while (view.status.state === "input-required") {
    if (Date.now() >= deadline) return { state: view.status.state, view };
    await sleep(500);
    view = await a2a<TaskView>(config, local, "tasks/get", { id: localTask });
  }
  return { state: view.status.state, view };
}

async function wait(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const config = await loadNodeConfig(flags);
  const peer = requireFlag(flags, "peer");
  const task = requireFlag(flags, "task");
  const localTask = flag(flags, "local-task");
  const timeoutS = Number(flag(flags, "timeout") ?? "30");
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("--timeout must be a positive number of seconds");
  const deadline = Date.now() + timeoutS * 1000;
  const escalated = new Set<string>();
  let view = await a2a<TaskView>(config, peer, "tasks/get", { id: task });
  for (;;) {
    if (TERMINAL.has(view.status.state)) break;
    if (view.status.state === "input-required") {
      const request = permissionRequestOf(view);
      if (request === null || localTask === undefined) break;
      if (!escalated.has(request.request_id)) {
        escalated.add(request.request_id);
        const seconds = Math.max(1, Math.round((deadline - Date.now()) / 1000));
        const outcome = await escalateToOrigin(config, peer, task, localTask, seconds);
        if (outcome.state === "input-required") {
          printView(view, wantsJson(flags));
          return 2;
        }
        view = await a2a<TaskView>(config, peer, "tasks/get", { id: task });
        continue;
      }
    }
    if (Date.now() >= deadline) {
      printView(view, wantsJson(flags));
      return 2;
    }
    await sleep(500);
    view = await a2a<TaskView>(config, peer, "tasks/get", { id: task });
  }
  printView(view, wantsJson(flags));
  if (view.status.state === "completed") return 0;
  if (view.status.state === "input-required") return 3;
  return 1;
}

async function escalate(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const config = await loadNodeConfig(flags);
  const peer = requireFlag(flags, "peer");
  const childTask = requireFlag(flags, "task");
  const localTask = requireFlag(flags, "local-task");
  const timeoutS = Number(flag(flags, "timeout") ?? "120");
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("--timeout must be a positive number of seconds");

  const outcome = await escalateToOrigin(config, peer, childTask, localTask, timeoutS);
  printView(outcome.view, wantsJson(flags));
  if (outcome.state === "working" || outcome.state === "completed") return 0;
  return outcome.state === "input-required" ? 2 : 1;
}

async function members(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const config = await loadNodeConfig(flags);
  const peer = flag(flags, "peer") ?? localEndpoint(config);
  const response = await signedJson<MembersResponse>(config, peer, "GET", "/cluster/members");
  if (wantsJson(flags)) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return 0;
  }
  const self = config.orca_node_id;
  process.stdout.write(`members ${response.members.length} digest ${response.members_digest.slice(0, 12)}\n`);
  for (const peerView of response.members) {
    const marker = peerView.orca_node_id === self ? "*" : " ";
    process.stdout.write(`${marker} ${peerView.orca_node_id}\t${peerView.endpoint ?? "-"}\t${peerView.state}\t${peerView.display_name}\n`);
  }
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Accept global flags before or after the subcommand: agents often put
  // `--data-root` first, so peel it off and hand it to every command.
  const global: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] as string;
    if (arg === "--data-root" || arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined) usageError(`${arg} requires a value`);
      global.push(arg, value);
      index += 2;
      continue;
    }
    break;
  }
  const [command, ...rest] = argv.slice(index);
  const args = [...global, ...rest];
  if (command === "serve") return serve(args);
  if (command === "send") process.exitCode = await send(args);
  else if (command === "status") process.exitCode = await status(args);
  else if (command === "wait") process.exitCode = await wait(args);
  else if (command === "escalate") process.exitCode = await escalate(args);
  else if (command === "members") process.exitCode = await members(args);
  else {
    process.stdout.write(USAGE);
    if (command !== undefined && command !== "--help" && command !== "-h" && command !== "help") {
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`orca-node: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
