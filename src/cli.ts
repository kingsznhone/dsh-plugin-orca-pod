#!/usr/bin/env node
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { join, basename } from "node:path";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { createFileBlobRegistry } from "./blob_files.ts";
import { configPath, defaultDataRoot, endpointWriteback, loadConfig, saveConfig, workgroupKey, type OrcaNodeConfig } from "./config.ts";
import { blobLinkSignature, buildAuthHeader } from "./crypto.ts";
import { loadIdentity, type NodeIdentity } from "./identity.ts";
import { createOrcaNode, createPersistentStorage, joinRoster } from "./index.ts";
import type { A2AMessage, MembersResponse, TaskRelay, TaskView } from "./protocol.ts";
import { parseModelSpec, permissionRequestOf } from "./protocol.ts";
import { createSqliteDispatchStore, createSqliteFileBlobStore } from "./sqlite.ts";

const USAGE = `orca-node

Usage:
  orca-node serve   --config <path> [--peer <url>]        start an orca node from a config file
  orca-node send    --peer <url> --text <text|-> [--file <path> ...] [--local-task <this task>] [--context <id>] [--permission-mode <mode>] [--model <provider/model>] [--reasoning-effort <effort>] [--json]
  orca-node status  --peer <url> --task <id> [--json]
  orca-node wait    --peer <url> --task <id> [--local-task <this task>] [--timeout <seconds>] [--json]
  orca-node escalate --peer <child> --task <child task> --local-task <this task> [--timeout <s>] [--json]
  orca-node publish <path> [--ttl <seconds>] [--json]  expose a produced file as a blob URL
  orca-node log [--json]                               tasks this node dispatched (§13.4)
  orca-node members [--peer <url>] [--json]
  orca-node --help                                      show this help

Common options:
  --config <path>       use a config file instead of <data-root>/config.json
  --data-root <path>    directory holding config.json (default ~/.orca-pod)

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

/** Every value of a repeatable flag (`--file a --file b` or `--file=a`). */
function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length));
      continue;
    }
    if (arg === `--${name}` && index + 1 < args.length) {
      values.push(args[index + 1] as string);
      index += 1;
    }
  }
  return values;
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
  return config.endpoints[0] ?? `http://${config.bind.host}:${config.bind.port}`;
}

/**
 * Local control plane: always dial loopback, never a published endpoint. The
 * gateway only accepts child links from loopback without proxy headers (§7.1).
 */
function localControlEndpoint(config: OrcaNodeConfig): string {
  const host = config.bind.host === "::1" ? "[::1]" : "127.0.0.1";
  return `http://${host}:${config.bind.port}`;
}

function nodeIdentity(config: OrcaNodeConfig): NodeIdentity {
  const identity = loadIdentity(config.data_root);
  if (identity === null || identity.orcaNodeId !== config.orca_node_id) {
    throw new Error("identity.json is missing or does not match config.orca_node_id; reset the orca node to migrate");
  }
  return identity;
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
        identity: nodeIdentity(config),
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
        identity: nodeIdentity(config),
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
  const writeback = endpointWriteback(config, url);
  if (writeback !== null) await saveConfig(explicit, writeback);
  // `--peer` bootstraps a fresh node into an existing mesh at startup; the
  // harness (and `npm run harness`) relies on this to avoid a separate join step.
  const bootstrap = flag(flags, "peer");
  if (bootstrap !== undefined) {
    const response = await orcaNode.join(normalizePeer(bootstrap));
    await joinRoster(orcaNode, response.members);
  }
  process.stdout.write(`orca-node ${orcaNode.orcaNodeId} listening on ${url}\n`);

  const shutdown = (): void => {
    void orcaNode.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Upload one attachment as a content-addressed blob (§5.6). The client hashes
 * the file first and signs that digest, so the body streams without buffering.
 */
async function uploadBlob(
  config: OrcaNodeConfig,
  peer: string,
  filePath: string,
): Promise<{ blob_id: string; size: number; name: string }> {
  const name = basename(filePath);
  const digest = await sha256File(filePath);
  const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
  const url = new URL("/blobs", normalizePeer(peer));
  url.searchParams.set("name", name);
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-pod-body-sha256": digest,
      authorization: buildAuthHeader({
        identity: nodeIdentity(config),
        method: "POST",
        path: "/blobs",
        bodySha256: digest,
      }),
    },
    body,
    duplex: "half",
  };
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`blob upload failed for ${filePath}: ${response.status} ${text}`);
  }
  const uploaded = JSON.parse(text) as { blob_id: string; size: number; name: string | null };
  return { blob_id: uploaded.blob_id, size: uploaded.size, name: uploaded.name ?? name };
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
  const permissionModeFlag = flag(flags, "permission-mode");
  let metadata = metadataRaw === undefined ? undefined : (JSON.parse(metadataRaw) as Record<string, unknown>);
  const pod = (metadata?.["pod"] as Record<string, unknown> | undefined) ?? {};
  if (permissionModeFlag !== undefined) pod["permission_mode"] = permissionModeFlag;
  const modelFlag = flag(flags, "model");
  const reasoningFlag = flag(flags, "reasoning-effort");
  if (modelFlag !== undefined) {
    const selection = parseModelSpec(modelFlag, reasoningFlag);
    if (selection === null) throw new Error("--model must be a provider/model pair, e.g. deepseek/deepseek-flash");
    pod["model"] = selection;
  } else if (reasoningFlag !== undefined) {
    // Effort-only override: the target keeps its local model and changes only
    // the reasoning effort (§6.15).
    pod["reasoning_effort"] = reasoningFlag;
  }
  const uploads: Array<{ blob_id: string; size: number; name: string }> = [];
  const seen = new Set<string>();
  for (const file of flagValues(args, "file")) {
    const uploaded = await uploadBlob(config, peer, file);
    if (seen.has(uploaded.name)) throw new Error(`duplicate input file name ${uploaded.name}`);
    seen.add(uploaded.name);
    uploads.push(uploaded);
  }
  if (uploads.length > 0) {
    pod["inputs"] = uploads.map((uploaded) => ({ blob_id: uploaded.blob_id, name: uploaded.name }));
  }
  // Inherit the delegation chain from the local parent task (§5.1). The target
  // validates `pod.chain` and later matches an origin-signed grant against it,
  // so a permission escalated through this node can resume the child (§7.12).
  const parentLocalTask = flag(flags, "local-task") ?? process.env["ORCA_POD_PARENT_TASK"];
  if (parentLocalTask !== undefined && parentLocalTask.length > 0) {
    const parentView = await signedJson<TaskView>(
      config,
      localControlEndpoint(config),
      "GET",
      `/cluster/task?task=${encodeURIComponent(parentLocalTask)}`,
    );
    const parentPod = (parentView.metadata?.["pod"] as Record<string, unknown> | undefined) ?? {};
    const parentChain = Array.isArray(parentPod["chain"])
      ? (parentPod["chain"] as unknown[]).filter((hop): hop is string => typeof hop === "string")
      : [];
    pod["hop"] = (typeof parentPod["hop"] === "number" ? parentPod["hop"] : 0) + 1;
    pod["chain"] = [...parentChain, config.orca_node_id];
    pod["root"] = typeof parentPod["root"] === "string" ? parentPod["root"] : parentLocalTask;
    if (pod["permission_mode"] === undefined && typeof parentPod["permission_mode"] === "string") {
      pod["permission_mode"] = parentPod["permission_mode"];
    }
  }
  if (Object.keys(pod).length > 0) metadata = { ...(metadata ?? {}), pod };
  const message: A2AMessage = {
    role: "user",
    parts: [{ kind: "text", text }],
    ...(context !== undefined ? { contextId: context } : {}),
  };
  const view = await a2a<TaskView>(config, peer, "message/send", {
    message,
    ...(metadata !== undefined ? { metadata } : {}),
  });
  // §7.12: register the child link so this node relays the child's permission
  // requests automatically instead of making the agent call `escalate`.
  if (parentLocalTask !== undefined && parentLocalTask.length > 0) {
    try {
      await signedJson(config, localControlEndpoint(config), "POST", "/cluster/child-link", {
        parent_task_id: parentLocalTask,
        peer: normalizePeer(peer),
        child_task_id: view.id,
      });
    } catch (error) {
      process.stderr.write(
        `orca-pod: could not register child link: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  const json = wantsJson(flags);
  if (!json) {
    for (const uploaded of uploads) {
      process.stdout.write(`uploaded ${uploaded.name} (${uploaded.size} bytes) ${uploaded.blob_id}\n`);
    }
  }
  printView(view, json);
  return 0;
}

/** Index of the first bare token, skipping `--flag value` pairs (global flags may precede it). */
function firstPositionalIndex(args: string[]): number {
  const valueFlags = new Set(["--data-root", "--config", "--path", "--ttl"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) return index;
  }
  return -1;
}

/**
 * Publish a produced file as a blob URL (§5.6). Registration writes the mapping
 * straight into the node's SQLite database — no HTTP route, because a shared
 * workgroup key cannot prove which node signed a request, so "only local callers
 * may publish paths" cannot be enforced over the network. The URL is signed
 * locally and works while the node runs.
 */
async function publish(args: string[]): Promise<number> {
  const positionalIndex = firstPositionalIndex(args);
  const positional = positionalIndex >= 0 ? (args[positionalIndex] as string) : undefined;
  const rest =
    positionalIndex >= 0 ? [...args.slice(0, positionalIndex), ...args.slice(positionalIndex + 1)] : args;
  const flags = parseFlags(rest);
  const config = await loadNodeConfig(flags);
  const path = positional ?? requireFlag(flags, "path");
  const rawTtl = flag(flags, "ttl");
  const ttlS = rawTtl === undefined ? undefined : Number(rawTtl);
  if (ttlS !== undefined && (!Number.isFinite(ttlS) || ttlS <= 0)) {
    throw new Error("--ttl must be a positive number of seconds");
  }
  const store = createSqliteFileBlobStore(join(config.data_root, "tasks.db"));
  let blob;
  try {
    blob = await createFileBlobRegistry(store).register(path, ttlS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot publish ${path}: ${message}`);
  } finally {
    store.close();
  }
  const expiresAtMs = Date.now() + 24 * 3600 * 1000;
  const exp = String(Math.floor(expiresAtMs / 1000));
  const sig = blobLinkSignature(nodeIdentity(config), blob.blob_id, exp);
  const base = config.endpoints[0] ?? (config.bind.port > 0 ? localEndpoint(config) : null);
  if (base === null) {
    throw new Error("publish needs a known endpoint: set `endpoints` in the config or run `orca-node serve` once");
  }
  const result = {
    blob_id: blob.blob_id,
    size: blob.size,
    expires_at: blob.expires_at,
    url: `${base.replace(/\/+$/, "")}/blobs/${blob.blob_id}?exp=${exp}&sig=${sig}`,
  };
  process.stdout.write(`${wantsJson(flags) ? JSON.stringify(result) : result.url}\n`);
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
  timeoutS: number | undefined,
): Promise<{ state: string; view: TaskView }> {
  const child = await a2a<TaskView>(config, childPeer, "tasks/get", { id: childTask });
  const request = permissionRequestOf(child);
  if (request === null) throw new Error(`task ${childTask} on ${childPeer} is not waiting for permission`);
  const relay: TaskRelay = { peer: normalizePeer(childPeer), task_id: childTask, request };
  const local = localEndpoint(config);
  let view = await a2a<TaskView>(config, local, "tasks/escalate", { taskId: localTask, relay });
  const deadline = timeoutS === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutS * 1000;
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
  const timeoutFlag = flag(flags, "timeout");
  const timeoutS = timeoutFlag === undefined ? undefined : Number(timeoutFlag);
  if (timeoutS !== undefined && (!Number.isFinite(timeoutS) || timeoutS <= 0)) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  const deadline = timeoutS === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutS * 1000;
  const escalated = new Set<string>();
  let view = await a2a<TaskView>(config, peer, "tasks/get", { id: task });
  for (;;) {
    if (TERMINAL.has(view.status.state)) break;
    if (view.status.state === "input-required") {
      const request = permissionRequestOf(view);
      if (request === null || localTask === undefined) break;
      if (!escalated.has(request.request_id)) {
        escalated.add(request.request_id);
        const seconds = Number.isFinite(deadline)
          ? Math.max(1, Math.round((deadline - Date.now()) / 1000))
          : undefined;
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
  const timeoutFlag = flag(flags, "timeout");
  const timeoutS = timeoutFlag === undefined ? undefined : Number(timeoutFlag);
  if (timeoutS !== undefined && (!Number.isFinite(timeoutS) || timeoutS <= 0)) {
    throw new Error("--timeout must be a positive number of seconds");
  }

  const outcome = await escalateToOrigin(config, peer, childTask, localTask, timeoutS);
  printView(outcome.view, wantsJson(flags));
  if (outcome.state === "working" || outcome.state === "completed") return 0;
  return outcome.state === "input-required" ? 2 : 1;
}

async function logCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const config = await loadNodeConfig(flags);
  // Read the origin-side dispatch log straight from SQLite: the node may be down,
  // and a restart is exactly when this listing matters (§13.4).
  const store = createSqliteDispatchStore(join(config.data_root, "tasks.db"));
  try {
    const entries = store.list().sort((left, right) => left.updated_at.localeCompare(right.updated_at));
    if (wantsJson(flags)) {
      process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
      return 0;
    }
    if (entries.length === 0) {
      process.stdout.write("no dispatched tasks\n");
      return 0;
    }
    for (const entry of entries) {
      const parent = entry.parent_local_task_id === undefined ? "" : `  parent=${entry.parent_local_task_id}`;
      const error = entry.last_error === undefined ? "" : `  (${entry.last_error})`;
      process.stdout.write(
        `${entry.state.padEnd(14)} ${entry.task_id}  ${entry.peer}${parent}${error}\n`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
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
    process.stdout.write(`${marker} ${peerView.orca_node_id}\t${peerView.endpoints.join(",") || "-"}\t${peerView.state}\t${peerView.display_name}\n`);
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
  else if (command === "publish") process.exitCode = await publish(args);
  else if (command === "log") process.exitCode = await logCommand(args);
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
