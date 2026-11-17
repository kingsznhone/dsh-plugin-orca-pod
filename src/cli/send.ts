/** `orca-node send`: dispatch a task to a peer, with attachments and an inherited delegation chain. */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";

import { childPodMetadata } from "../tasks/delegation.ts";
import { parseEchoScript } from "../execution/echo.ts";
import { errorMessage } from "../kernel/errors.ts";
import { parseSchema, describeIssue } from "../kernel/schema.ts";
import { AckSchema, BlobUploadResponseSchema } from "../protocol/a2a.ts";
import { PermissionModeSchema, type PermissionMode } from "../protocol/permission.ts";
import {
  PodTaskMetadataSchema,
  TaskMetadataSchema,
  TaskViewSchema,
  type A2AMessage,
  type PodTaskMetadata,
  type TaskInputRef,
  type TaskMetadata,
} from "../protocol/task.ts";
import { parseModelSpec } from "../protocol/model.ts";
import type { PeerClient } from "../protocol/client.ts";
import { normalizePeerUrl } from "../transport/net.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  localControlEndpoint,
  peerClient,
  printView,
  required,
  type CommandArgs,
  type Flags,
  type OptionName,
} from "./shared.ts";
import type { OrcaNodeConfig } from "../node/config.ts";

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

/** An attachment that reached the target: the input ref the task carries, and how big it was. */
type UploadedFile = TaskInputRef & { size: number };

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
async function uploadBlob(client: PeerClient, peer: string, filePath: string): Promise<UploadedFile> {
  const name = basename(filePath);
  const digest = await sha256File(filePath);
  const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
  const uploaded = await client.upload(
    peer,
    {
      path: `/blobs?name=${encodeURIComponent(name)}`,
      body,
      sha256: digest,
      reply: BlobUploadResponseSchema,
    },
    { timeoutMs: UPLOAD_TIMEOUT_MS },
  );
  return { blob_id: uploaded.blob_id, size: uploaded.size, name: uploaded.name ?? name };
}

async function uploadAll(client: PeerClient, peer: string, files: readonly string[]): Promise<UploadedFile[]> {
  const uploads: UploadedFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const uploaded = await uploadBlob(client, peer, file);
    if (seen.has(uploaded.name)) throw new Error(`duplicate input file name ${uploaded.name}`);
    seen.add(uploaded.name);
    uploads.push(uploaded);
  }
  return uploads;
}

/** `--metadata`: a JSON object; its `pod` block is the starting point of the one built below. */
function parseMetadataFlag(raw: string | undefined): { metadata: TaskMetadata; pod: PodTaskMetadata } {
  if (raw === undefined) return { metadata: {}, pod: {} };
  const parsed = parseSchema(TaskMetadataSchema, JSON.parse(raw));
  if (!parsed.ok) throw new Error(`--metadata must be a JSON object (${describeIssue(parsed.issue)})`);
  const pod = parseSchema(PodTaskMetadataSchema, parsed.value.pod ?? {});
  if (!pod.ok) throw new Error(`--metadata pod ${describeIssue(pod.issue)}`);
  return { metadata: parsed.value, pod: pod.value };
}

function permissionModeFlag(raw: string): PermissionMode {
  const parsed = parseSchema(PermissionModeSchema, raw);
  if (!parsed.ok) throw new Error(`--permission-mode must be read-only, workspace-write or danger-full-access`);
  return parsed.value;
}

/** `--echo`: validated through the executor's own parser, so a bad script fails here and not on the target (§6.3). */
function parseEchoFlag(raw: string) {
  let script: unknown;
  try {
    script = JSON.parse(raw);
  } catch {
    throw new Error("--echo must be a JSON object");
  }
  return parseEchoScript(script);
}

/** Model route and reasoning effort flags, as the `pod` fields they set (§6.15). */
function modelFields(flags: Flags): Pick<PodTaskMetadata, "model" | "reasoning_effort"> {
  const { model: modelFlag, "reasoning-effort": reasoningFlag } = flags;
  if (modelFlag !== undefined) {
    const selection = parseModelSpec(modelFlag, reasoningFlag);
    if (selection === null) throw new Error("--model must be a provider/model pair, e.g. deepseek/deepseek-flash");
    return { model: selection };
  }
  // Effort-only override: the target keeps its local model and changes only the reasoning effort.
  return reasoningFlag === undefined ? {} : { reasoning_effort: reasoningFlag };
}

/**
 * Inherit the delegation chain from the local parent task (§5.1). The target
 * validates `pod.chain` and later matches an origin-signed grant against it, so
 * a permission escalated through this node can resume the child (§7.12). The
 * root origin rides along so a grant from the top of the tree can be verified
 * at the leaf without trusting the middle hops (§7.11).
 */
async function inheritedFields(
  client: PeerClient,
  config: OrcaNodeConfig,
  parentLocalTask: string,
): Promise<PodTaskMetadata> {
  const parentView = await client.call(localControlEndpoint(config), {
    method: "GET",
    path: `/cluster/task?task=${encodeURIComponent(parentLocalTask)}`,
    reply: TaskViewSchema,
  });
  const parentPod = parseSchema(PodTaskMetadataSchema, parentView.metadata?.pod ?? {});
  return childPodMetadata(parentPod.ok ? parentPod.value : undefined, parentLocalTask, config.orca_node_id);
}

/** §7.12: register the child link so this node relays the child's permission requests automatically. */
async function registerChildLink(
  client: PeerClient,
  config: OrcaNodeConfig,
  link: { parentTaskId: string; peer: string; childTaskId: string },
): Promise<void> {
  try {
    await client.call(localControlEndpoint(config), {
      method: "POST",
      path: "/cluster/child-link",
      payload: { parent_task_id: link.parentTaskId, peer: link.peer, child_task_id: link.childTaskId },
      reply: AckSchema,
    });
  } catch (error) {
    process.stderr.write(`orca-pod: could not register child link: ${errorMessage(error)}\n`);
  }
}

export async function run({ flags }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  const peer = normalizePeerUrl(required(flags.peer, "peer"));
  const client = await peerClient(config, peer);
  const raw = required(flags.text, "text");
  const text = raw === "-" ? await readStdin() : raw;
  if (text.length === 0) throw new Error("--text must not be empty (pipe text with --text -)");
  const parentLocalTask = [flags["local-task"], process.env.ORCA_POD_PARENT_TASK].find(
    (value) => value !== undefined && value.length > 0,
  );

  const { metadata, pod: given } = parseMetadataFlag(flags.metadata);
  const uploads = await uploadAll(client, peer, flags.file ?? []);
  // The flags override what `--metadata` carried; what the parent task passes on comes last,
  // except that an explicit permission mode stays (B18: it is not narrowed against the parent's).
  const inherited = parentLocalTask === undefined ? {} : await inheritedFields(client, config, parentLocalTask);
  const mode =
    flags["permission-mode"] === undefined ? given.permission_mode : permissionModeFlag(flags["permission-mode"]);
  const pod: PodTaskMetadata = {
    ...given,
    ...modelFields(flags),
    ...(uploads.length > 0 ? { inputs: uploads.map(({ blob_id, name }) => ({ blob_id, name })) } : {}),
    ...inherited,
    ...(mode === undefined ? {} : { permission_mode: mode }),
  };
  const sent: TaskMetadata = {
    ...metadata,
    ...(flags.echo === undefined ? {} : { echo: parseEchoFlag(flags.echo) }),
    ...(Object.keys(pod).length > 0 ? { pod } : {}),
  };
  const message: A2AMessage = {
    role: "user",
    parts: [{ kind: "text", text }],
    ...(flags.context !== undefined ? { contextId: flags.context } : {}),
  };
  const view = await client.rpc(peer, "message/send", {
    message,
    metadata: Object.keys(sent).length > 0 ? sent : undefined,
  });
  if (parentLocalTask !== undefined) {
    await registerChildLink(client, config, { parentTaskId: parentLocalTask, peer, childTaskId: view.id });
  }
  if (flags.json !== true) {
    for (const uploaded of uploads) {
      process.stdout.write(`uploaded ${uploaded.name} (${uploaded.size} bytes) ${uploaded.blob_id}\n`);
    }
  }
  printView(view, flags);
  return 0;
}
