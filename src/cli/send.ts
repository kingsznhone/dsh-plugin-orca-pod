/** `orca-node send`: dispatch a task to a peer, with attachments and an inherited delegation chain. */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";

import { parseEchoScript } from "../execution/index.ts";
import { errorMessage } from "../kernel/index.ts";
import { parseModelSpec, type A2AMessage, type TaskView } from "../protocol/index.ts";
import { normalizePeerUrl, type PeerClient } from "../transport/index.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  localControlEndpoint,
  peerClient,
  printView,
  required,
  type CommandArgs,
  type OptionName,
} from "./shared.ts";

export const options: readonly OptionName[] = [
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
];

/** A large upload may outlast the default deadline of an ordinary call. */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
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

export async function run({ flags }: CommandArgs): Promise<number> {
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
