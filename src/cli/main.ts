#!/usr/bin/env node
import process from "node:process";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";

import { createFileBlobRegistry } from "../storage/blob-files.ts";
import {
  configPath,
  defaultDataRoot,
  endpointWriteback,
  loadConfig,
  saveConfig,
  type OrcaNodeConfig,
  createOrcaNode,
  createPersistentStorage,
  joinRoster,
  parseSettings,
} from "../node/index.ts";
import { blobLinkSignature, loadIdentity, type NodeIdentity } from "../security/index.ts";
import { parseEchoScript } from "../execution/index.ts";
import { normalizePeerUrl, createPeerClient, type PeerClient } from "../transport/index.ts";
import type { A2AMessage, MembersResponse, PeerView, TaskRelay, TaskView } from "../protocol/index.ts";
import { isTerminal, parseModelSpec, permissionRequestOf } from "../protocol/index.ts";
import { createSqliteDispatchStore, createSqliteFileBlobStore } from "../storage/sqlite.ts";
import { errorMessage } from "../kernel/index.ts";

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

const OPTIONS = {
  config: { type: "string" },
  "data-root": { type: "string" },
  peer: { type: "string" },
  bind: { type: "string" },
  port: { type: "string" },
  text: { type: "string" },
  file: { type: "string", multiple: true },
  "local-task": { type: "string" },
  context: { type: "string" },
  "permission-mode": { type: "string" },
  model: { type: "string" },
  "reasoning-effort": { type: "string" },
  echo: { type: "string" },
  metadata: { type: "string" },
  task: { type: "string" },
  timeout: { type: "string" },
  ttl: { type: "string" },
  path: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type OptionName = keyof typeof OPTIONS;

const COMMON_OPTIONS = ["config", "data-root"] as const;

/** The options each command accepts; anything else is a usage error. */
const COMMANDS = {
  serve: ["config", "peer", "bind", "port"],
  send: [
    ...COMMON_OPTIONS,
    "peer",
    "text",
    "file",
    "local-task",
    "context",
    "permission-mode",
    "model",
    "reasoning-effort",
    "echo",
    "metadata",
    "json",
  ],
  status: [...COMMON_OPTIONS, "peer", "task", "json"],
  wait: [...COMMON_OPTIONS, "peer", "task", "local-task", "timeout", "json"],
  escalate: [...COMMON_OPTIONS, "peer", "task", "local-task", "timeout", "json"],
  publish: [...COMMON_OPTIONS, "path", "ttl", "json"],
  log: [...COMMON_OPTIONS, "json"],
  members: [...COMMON_OPTIONS, "peer", "json"],
} as const satisfies Record<string, readonly OptionName[]>;

type CommandName = keyof typeof COMMANDS;

function parseCli(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
}

type Flags = ReturnType<typeof parseCli>["values"];

function isCommand(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

/** A positive number of seconds, or `undefined` when the flag is absent. */
function positiveSeconds(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--${name} must be a positive number of seconds`);
  return seconds;
}

async function loadNodeConfig(flags: Flags): Promise<OrcaNodeConfig> {
  if (flags.config !== undefined) return loadConfig(flags.config);
  return loadConfig(configPath(flags["data-root"] ?? defaultDataRoot()));
}

function localEndpoint(config: OrcaNodeConfig): string {
  return config.endpoints[0] ?? `http://${config.bind_host}:${config.port}`;
}

/**
 * Local control plane: always dial loopback, never a published endpoint. The
 * gateway only accepts child links from loopback without proxy headers (§7.1).
 */
function localControlEndpoint(config: OrcaNodeConfig): string {
  const host = config.bind_host === "::1" ? "[::1]" : "127.0.0.1";
  return `http://${host}:${config.port}`;
}

function nodeIdentity(config: OrcaNodeConfig): NodeIdentity {
  const identity = loadIdentity(config.data_root);
  if (identity === null || identity.orcaNodeId !== config.orca_node_id) {
    throw new Error("identity.json is missing or does not match config.orca_node_id");
  }
  return identity;
}

/** A large upload may outlast the default deadline of an ordinary call. */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The one signing client of this process, with the identity read once. It reaches
 * this node (over loopback) and the members this node knows: a peer the local
 * node has not joined is refused, not joined behind the caller's back.
 */
async function peerClient(config: OrcaNodeConfig, peer: string): Promise<PeerClient> {
  let roster: PeerView[] = [];
  const client = createPeerClient({
    identity: nodeIdentity(config),
    fetch: (url, init) => fetch(url, init),
    timeoutMs: config.request_timeout_ms ?? 30_000,
    selfEndpoints: () => [localControlEndpoint(config), localEndpoint(config), ...config.endpoints],
    roster: () => roster,
  });
  if (client.idOf(peer) === undefined) {
    roster = (await client.call<MembersResponse>(localEndpoint(config), "GET", "/cluster/members")).members;
    if (client.idOf(peer) === undefined) {
      throw new Error(`${peer} is not a member known to this node; join it first (orca-node serve --peer ${peer})`);
    }
  }
  return client;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

function statusLine(view: TaskView): string {
  const part = view.status.message?.parts.find((item) => item.kind === "text");
  const text = part !== undefined && part.kind === "text" ? part.text : "";
  return `task ${view.id} ${view.status.state}${view.status.reason ? ` (${view.status.reason})` : ""}${text ? `: ${text}` : ""}`;
}

function printView(view: TaskView, flags: Flags): void {
  process.stdout.write(`${flags.json === true ? JSON.stringify(view, null, 2) : statusLine(view)}\n`);
}

async function serve(flags: Flags): Promise<void> {
  const explicit = required(flags.config, "config");
  const config = await loadConfig(explicit);
  // Explicit listen overrides are useful for one-off runs and for the harness:
  // the persisted config keeps whatever the operator installed.
  const listen = parseSettings({
    bind_host: flags.bind ?? config.bind_host,
    port: flags.port === undefined ? config.port : Number(flags.port),
  });
  config.bind_host = listen.bind_host;
  config.port = listen.port;
  const orcaNode = createOrcaNode({ config, storage: createPersistentStorage(config), logger: console });
  const { url } = await orcaNode.start();
  const writeback = endpointWriteback(config, url);
  if (writeback !== null) await saveConfig(explicit, writeback);
  // `--peer` bootstraps a fresh node into an existing mesh at startup; the
  // harness (and `npm run harness`) relies on this to avoid a separate join step.
  if (flags.peer !== undefined) {
    const response = await orcaNode.join(normalizePeerUrl(flags.peer));
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
  client: PeerClient,
  peer: string,
  filePath: string,
): Promise<{ blob_id: string; size: number; name: string }> {
  const name = basename(filePath);
  const digest = await sha256File(filePath);
  const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
  const uploaded = await client.upload<{ blob_id: string; size: number; name: string | null }>(
    peer,
    `/blobs?name=${encodeURIComponent(name)}`,
    body,
    digest,
    { timeoutMs: UPLOAD_TIMEOUT_MS },
  );
  return { blob_id: uploaded.blob_id, size: uploaded.size, name: uploaded.name ?? name };
}

async function send(flags: Flags): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = normalizePeerUrl(required(flags.peer, "peer"));
  const client = await peerClient(config, peer);
  const raw = required(flags.text, "text");
  const text = raw === "-" ? await readStdin() : raw;
  if (text.length === 0) throw new Error("--text must not be empty (pipe text with --text -)");
  const context = flags.context;
  let metadata = flags.metadata === undefined ? undefined : (JSON.parse(flags.metadata) as Record<string, unknown>);
  const pod = (metadata?.pod as Record<string, unknown> | undefined) ?? {};
  if (flags["permission-mode"] !== undefined) pod.permission_mode = flags["permission-mode"];
  const modelFlag = flags.model;
  const reasoningFlag = flags["reasoning-effort"];
  if (modelFlag !== undefined) {
    const selection = parseModelSpec(modelFlag, reasoningFlag);
    if (selection === null) throw new Error("--model must be a provider/model pair, e.g. deepseek/deepseek-flash");
    pod.model = selection;
  } else if (reasoningFlag !== undefined) {
    // Effort-only override: the target keeps its local model and changes only
    // the reasoning effort (§6.15).
    pod.reasoning_effort = reasoningFlag;
  }
  if (flags.echo !== undefined) {
    let script: unknown;
    try {
      script = JSON.parse(flags.echo);
    } catch {
      throw new Error("--echo must be a JSON object");
    }
    // Validate through the executor's own parser so a bad script fails on the
    // dispatching side instead of as an executor error on the target (§6.3).
    metadata = { ...(metadata ?? {}), echo: parseEchoScript(script) };
  }
  const uploads: Array<{ blob_id: string; size: number; name: string }> = [];
  const seen = new Set<string>();
  for (const file of flags.file ?? []) {
    const uploaded = await uploadBlob(client, peer, file);
    if (seen.has(uploaded.name)) throw new Error(`duplicate input file name ${uploaded.name}`);
    seen.add(uploaded.name);
    uploads.push(uploaded);
  }
  if (uploads.length > 0) {
    pod.inputs = uploads.map((uploaded) => ({ blob_id: uploaded.blob_id, name: uploaded.name }));
  }
  // Inherit the delegation chain from the local parent task (§5.1). The target
  // validates `pod.chain` and later matches an origin-signed grant against it,
  // so a permission escalated through this node can resume the child (§7.12).
  const parentLocalTask = flags["local-task"] ?? process.env.ORCA_POD_PARENT_TASK;
  if (parentLocalTask !== undefined && parentLocalTask.length > 0) {
    const parentView = await client.call<TaskView>(
      localControlEndpoint(config),
      "GET",
      `/cluster/task?task=${encodeURIComponent(parentLocalTask)}`,
    );
    const parentPod = (parentView.metadata?.pod as Record<string, unknown> | undefined) ?? {};
    const parentChain = Array.isArray(parentPod.chain)
      ? (parentPod.chain as unknown[]).filter((hop): hop is string => typeof hop === "string")
      : [];
    pod.hop = (typeof parentPod.hop === "number" ? parentPod.hop : 0) + 1;
    pod.chain = [...parentChain, config.orca_node_id];
    pod.root = typeof parentPod.root === "string" ? parentPod.root : parentLocalTask;
    // Root origin rides along so a grant from the top of the tree can be verified
    // at the leaf without trusting the middle hops (§7.11).
    if (typeof parentPod.root_origin === "string") pod.root_origin = parentPod.root_origin;
    if (pod.permission_mode === undefined && typeof parentPod.permission_mode === "string") {
      pod.permission_mode = parentPod.permission_mode;
    }
  }
  if (Object.keys(pod).length > 0) metadata = { ...(metadata ?? {}), pod };
  const message: A2AMessage = {
    role: "user",
    parts: [{ kind: "text", text }],
    ...(context !== undefined ? { contextId: context } : {}),
  };
  const view = await client.rpc<TaskView>(peer, "message/send", { message, metadata });
  // §7.12: register the child link so this node relays the child's permission
  // requests automatically instead of making the agent call `escalate`.
  if (parentLocalTask !== undefined && parentLocalTask.length > 0) {
    try {
      await client.call(localControlEndpoint(config), "POST", "/cluster/child-link", {
        parent_task_id: parentLocalTask,
        peer,
        child_task_id: view.id,
      });
    } catch (error) {
      process.stderr.write(`orca-pod: could not register child link: ${errorMessage(error)}\n`);
    }
  }
  if (flags.json !== true) {
    for (const uploaded of uploads) {
      process.stdout.write(`uploaded ${uploaded.name} (${uploaded.size} bytes) ${uploaded.blob_id}\n`);
    }
  }
  printView(view, flags);
  return 0;
}

/**
 * Publish a produced file as a blob URL (§5.6). Registration writes the mapping
 * straight into the node's SQLite database — there is no HTTP route for it, so
 * only a local caller can publish paths. The URL is signed locally and works
 * while the node runs.
 */
async function publish(flags: Flags, positional: string | undefined): Promise<number> {
  const config = await loadNodeConfig(flags);
  const path = positional ?? required(flags.path, "path");
  const ttlS = positiveSeconds(flags.ttl, "ttl");
  const store = createSqliteFileBlobStore(join(config.data_root, "tasks.db"));
  const blob = await createFileBlobRegistry(store)
    .register(path, ttlS)
    .catch((error: unknown) => {
      throw new Error(`cannot publish ${path}: ${errorMessage(error)}`);
    })
    .finally(() => store.close());
  const expiresAtMs = Date.now() + 24 * 3600 * 1000;
  const exp = String(Math.floor(expiresAtMs / 1000));
  const sig = blobLinkSignature(nodeIdentity(config), blob.blob_id, exp);
  const base = config.endpoints[0] ?? (config.port > 0 ? localEndpoint(config) : null);
  if (base === null) {
    throw new Error("publish needs a known endpoint: set `endpoints` in the config or run `orca-node serve` once");
  }
  const result = {
    blob_id: blob.blob_id,
    size: blob.size,
    expires_at: blob.expires_at,
    url: `${base.replace(/\/+$/, "")}/blobs/${blob.blob_id}?exp=${exp}&sig=${sig}`,
  };
  process.stdout.write(`${flags.json === true ? JSON.stringify(result) : result.url}\n`);
  return 0;
}

async function status(flags: Flags): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = normalizePeerUrl(required(flags.peer, "peer"));
  const task = required(flags.task, "task");
  const view = await (await peerClient(config, peer)).rpc<TaskView>(peer, "tasks/get", { id: task });
  printView(view, flags);
  return 0;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Push a child's pending permission request up to the origin of `localTask`
 * (§7.12). Resolves once the local task leaves `input-required`.
 */
async function escalateToOrigin(
  config: OrcaNodeConfig,
  client: PeerClient,
  childPeer: string,
  childTask: string,
  localTask: string,
  timeoutS: number | undefined,
): Promise<{ state: string; view: TaskView }> {
  const child = await client.rpc<TaskView>(childPeer, "tasks/get", { id: childTask });
  const request = permissionRequestOf(child);
  if (request === null) throw new Error(`task ${childTask} on ${childPeer} is not waiting for permission`);
  const relay: TaskRelay = { peer: childPeer, task_id: childTask, request };
  const local = localEndpoint(config);
  let view = await client.rpc<TaskView>(local, "tasks/escalate", { taskId: localTask, relay });
  const deadline = timeoutS === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutS * 1000;
  while (view.status.state === "input-required") {
    if (Date.now() >= deadline) return { state: view.status.state, view };
    await sleep(500);
    view = await client.rpc<TaskView>(local, "tasks/get", { id: localTask });
  }
  return { state: view.status.state, view };
}

async function wait(flags: Flags): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = normalizePeerUrl(required(flags.peer, "peer"));
  const client = await peerClient(config, peer);
  const task = required(flags.task, "task");
  const localTask = flags["local-task"];
  const timeoutS = positiveSeconds(flags.timeout, "timeout");
  const deadline = timeoutS === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutS * 1000;
  const escalated = new Set<string>();
  let view = await client.rpc<TaskView>(peer, "tasks/get", { id: task });
  for (;;) {
    if (isTerminal(view.status.state)) break;
    if (view.status.state === "input-required") {
      const request = permissionRequestOf(view);
      if (request === null || localTask === undefined) break;
      if (!escalated.has(request.request_id)) {
        escalated.add(request.request_id);
        const seconds = Number.isFinite(deadline) ? Math.max(1, Math.round((deadline - Date.now()) / 1000)) : undefined;
        const outcome = await escalateToOrigin(config, client, peer, task, localTask, seconds);
        if (outcome.state === "input-required") {
          printView(view, flags);
          return 2;
        }
        view = await client.rpc<TaskView>(peer, "tasks/get", { id: task });
        continue;
      }
    }
    if (Date.now() >= deadline) {
      printView(view, flags);
      return 2;
    }
    await sleep(500);
    view = await client.rpc<TaskView>(peer, "tasks/get", { id: task });
  }
  printView(view, flags);
  if (view.status.state === "completed") return 0;
  if (view.status.state === "input-required") return 3;
  return 1;
}

async function escalate(flags: Flags): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = normalizePeerUrl(required(flags.peer, "peer"));
  const childTask = required(flags.task, "task");
  const localTask = required(flags["local-task"], "local-task");
  const timeoutS = positiveSeconds(flags.timeout, "timeout");

  const outcome = await escalateToOrigin(config, await peerClient(config, peer), peer, childTask, localTask, timeoutS);
  printView(outcome.view, flags);
  if (outcome.state === "working" || outcome.state === "completed") return 0;
  return outcome.state === "input-required" ? 2 : 1;
}

async function logCommand(flags: Flags): Promise<number> {
  const config = await loadNodeConfig(flags);
  // Read the origin-side dispatch log straight from SQLite: the node may be down,
  // and a restart is exactly when this listing matters (§8.3).
  const store = createSqliteDispatchStore(join(config.data_root, "tasks.db"));
  try {
    const entries = store.list().sort((left, right) => left.updated_at.localeCompare(right.updated_at));
    if (flags.json === true) {
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
      process.stdout.write(`${entry.state.padEnd(14)} ${entry.task_id}  ${entry.peer}${parent}${error}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function members(flags: Flags): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = flags.peer === undefined ? localEndpoint(config) : normalizePeerUrl(flags.peer);
  const response = await (await peerClient(config, peer)).call<MembersResponse>(peer, "GET", "/cluster/members");
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return 0;
  }
  const self = config.orca_node_id;
  process.stdout.write(`members ${response.members.length} digest ${response.members_digest.slice(0, 12)}\n`);
  for (const peerView of response.members) {
    const marker = peerView.orca_node_id === self ? "*" : " ";
    process.stdout.write(
      `${marker} ${peerView.orca_node_id}\t${peerView.endpoints.join(",") || "-"}\t${peerView.state}\t${peerView.display_name}\n`,
    );
  }
  return 0;
}

async function main(): Promise<void> {
  const { values: flags, positionals } = parseCli(process.argv.slice(2));
  const [command, ...rest] = positionals;
  if (flags.help === true || command === undefined || command === "help" || !isCommand(command)) {
    process.stdout.write(USAGE);
    if (flags.help !== true && command !== undefined && command !== "help") process.exitCode = 1;
    return;
  }
  for (const name of Object.keys(flags) as OptionName[]) {
    if (!(COMMANDS[command] as readonly OptionName[]).includes(name)) {
      usageError(`--${name} is not an option of ${command}`);
    }
  }
  const maxPositionals = command === "publish" ? 1 : 0;
  if (rest.length > maxPositionals) usageError(`unexpected argument ${String(rest[maxPositionals])}`);
  if (command === "serve") return serve(flags);
  if (command === "send") process.exitCode = await send(flags);
  else if (command === "status") process.exitCode = await status(flags);
  else if (command === "wait") process.exitCode = await wait(flags);
  else if (command === "escalate") process.exitCode = await escalate(flags);
  else if (command === "publish") process.exitCode = await publish(flags, rest[0]);
  else if (command === "log") process.exitCode = await logCommand(flags);
  else process.exitCode = await members(flags);
}

main().catch((error: unknown) => {
  process.stderr.write(`orca-node: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
