/** `orca-node send`: dispatch a task to a peer. */

import process from "node:process";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { parseEchoScript } from "../execution/echo.ts";
import { runningInTask } from "../kernel/entry.ts";
import { parseSchema, describeIssue } from "../kernel/schema.ts";
import { SandboxModeSchema } from "../protocol/permission.ts";
import { SANDBOX_MODES } from "@deepseek-ai/dsh-sandbox-policy";
import {
  PodTaskMetadataSchema,
  TaskMetadataSchema,
  type A2AMessage,
  type PodTaskMetadata,
  type TaskMetadata,
} from "../protocol/task.ts";
import { parseModelSpec } from "../protocol/model.ts";
import { normalizePeerUrl } from "../transport/net.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  peerClient,
  printView,
  required,
  type CommandArgs,
  type Flags,
  type OptionName,
} from "./shared.ts";

export const options: readonly OptionName[] = [
  ...COMMON_OPTIONS,
  "peer",
  "text",
  "context",
  "permission-mode",
  "model",
  "reasoning-effort",
  "echo",
  "metadata",
  "json",
];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
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

function permissionModeFlag(raw: string): SandboxMode {
  const parsed = parseSchema(SandboxModeSchema, raw);
  if (!parsed.ok) throw new Error(`--permission-mode must be ${SANDBOX_MODES.join(", ")}`);
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

export async function run({ flags }: CommandArgs): Promise<number> {
  // Tasks are single-hop: an agent running a task reports back instead of dispatching (§7.9).
  if (runningInTask()) {
    throw new Error(
      "send is not available inside a task: tasks are single-hop. If you cannot finish alone, end your task with a BLOCKED: report for the origin.",
    );
  }
  const config = await loadNodeConfig(flags);
  const peer = normalizePeerUrl(required(flags.peer, "peer"));
  const client = await peerClient(config, peer);
  const raw = required(flags.text, "text");
  const text = raw === "-" ? await readStdin() : raw;
  if (text.length === 0) throw new Error("--text must not be empty (pipe text with --text -)");

  const { metadata, pod: given } = parseMetadataFlag(flags.metadata);
  // The flags override what `--metadata` carried.
  const mode =
    flags["permission-mode"] === undefined ? given.permission_mode : permissionModeFlag(flags["permission-mode"]);
  const pod: PodTaskMetadata = {
    ...given,
    ...modelFields(flags),
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
  printView(view, flags);
  return 0;
}
