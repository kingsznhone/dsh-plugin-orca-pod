/**
 * The task's `metadata` is untrusted input from another node. It is parsed once,
 * when the task is submitted, into the typed `TaskMeta` the rest of the task
 * code uses; nothing downstream re-reads the raw metadata.
 */

import { parseEchoScript, type EchoScript } from "./echo.ts";
import { PodError } from "./errors.ts";
import {
  isModelSelection,
  isPermissionMode,
  isReasoningEffort,
  isRecord,
  type A2AMessage,
  type ModelSelection,
  type PermissionMode,
  type SignedGrant,
  type TaskInputRef,
} from "./protocol.ts";
import { parseSignedGrant } from "./grants.ts";

export type TaskMeta = {
  /** Orca nodes this task was delegated through, origin first. */
  chain: string[];
  /** Origin of the whole delegation tree; a root task is its own tree's origin (§7.11). */
  rootOrigin: string;
  /** What the origin session allows; a task that names no mode runs read-only (§7.10). */
  permissionMode: PermissionMode;
  model: ModelSelection | undefined;
  /** The `reasoning_effort` field, else the effort pinned in `model` (§6.15). */
  effort: string | undefined;
  /** Origin's requested lifetime in seconds; the local cap still applies. */
  taskTtlS: number | undefined;
  inputs: TaskInputRef[];
  echo: EchoScript;
};

const INPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BLOB_ID_PATTERN = /^[0-9a-f]{64}$/;

function need(ok: boolean, message: string): asserts ok {
  if (!ok) throw new PodError("bad_request", message);
}

function parseInputs(raw: unknown): TaskInputRef[] {
  need(Array.isArray(raw), "pod.inputs must be an array");
  const seen = new Set<string>();
  return raw.map((item: unknown) => {
    need(isRecord(item), "pod.inputs entries must be objects");
    const { blob_id: blobId, name } = item;
    need(typeof blobId === "string" && BLOB_ID_PATTERN.test(blobId), "pod.inputs[].blob_id must be a sha256 blob id");
    need(
      typeof name === "string" && INPUT_NAME_PATTERN.test(name),
      `pod.inputs[].name "${String(name)}" is not a safe file name`,
    );
    if (seen.has(name)) throw new PodError("duplicate_input_name", `input name ${name} appears twice`);
    seen.add(name);
    return { blob_id: blobId, name };
  });
}

/**
 * Validate the `pod` block and the echo script of an incoming task (§5.1, §6.3,
 * §8.6). There is no hop limit — a workgroup is a handful of machines — so only
 * malformed metadata and a callback to an ancestor (`ancestor_call_forbidden`)
 * are rejected.
 *
 * The ancestors are the nodes in `pod.chain` plus the origin of the whole tree
 * (`pod.root_origin`). The root origin has to be named separately: a root task
 * dispatched with the plugin tool carries no chain, so the chain alone would
 * let A → B → A through. Every receiving node stores `root_origin` on the task,
 * and both child paths (the CLI with `--local-task`, a delegating local task)
 * copy it, so it reaches every hop of the tree.
 */
export function parsePodMetadata(
  metadata: Record<string, unknown> | undefined,
  selfOrcaNodeId: string,
  originOrcaNode: string,
): TaskMeta {
  const pod = metadata?.pod ?? {};
  need(isRecord(pod), "metadata.pod must be an object");
  const { hop, chain = [], root, root_origin, permission_mode, model, reasoning_effort, task_ttl_s, inputs } = pod;
  need(
    hop === undefined || (typeof hop === "number" && Number.isInteger(hop) && hop >= 0),
    "pod.hop must be a non-negative integer",
  );
  need(
    Array.isArray(chain) && chain.every((entry) => typeof entry === "string"),
    "pod.chain must be an array of orca node ids",
  );
  need(root === undefined || typeof root === "string", "pod.root must be a task id");
  need(root_origin === undefined || typeof root_origin === "string", "pod.root_origin must be an orca node id");
  need(
    permission_mode === undefined || isPermissionMode(permission_mode),
    "pod.permission_mode must be one of read-only, workspace-write, danger-full-access",
  );
  need(
    model === undefined || isModelSelection(model),
    "pod.model must name a provider, model and optional reasoning_effort",
  );
  need(
    reasoning_effort === undefined || isReasoningEffort(reasoning_effort),
    "pod.reasoning_effort must be a non-empty string",
  );
  need(
    task_ttl_s === undefined || (typeof task_ttl_s === "number" && Number.isFinite(task_ttl_s) && task_ttl_s > 0),
    "pod.task_ttl_s must be a positive number",
  );
  if (chain.includes(selfOrcaNodeId)) {
    throw new PodError(
      "ancestor_call_forbidden",
      `pod.chain already contains ${selfOrcaNodeId}; ancestors cannot be called back`,
    );
  }
  if (root_origin === selfOrcaNodeId) {
    throw new PodError(
      "ancestor_call_forbidden",
      `${selfOrcaNodeId} is the origin of this delegation tree; the root origin cannot be called back`,
    );
  }
  const echo = parseEchoScript(metadata?.echo);
  return {
    chain,
    rootOrigin: root_origin ?? originOrcaNode,
    permissionMode: permission_mode ?? "read-only",
    model,
    effort: reasoning_effort ?? model?.reasoning_effort,
    taskTtlS: task_ttl_s,
    inputs: inputs === undefined ? [] : parseInputs(inputs),
    echo,
  };
}

/** The human decision a resume message carries; null when it carries none. */
type ResumeControl = { kind: "grant"; grant: SignedGrant } | { kind: "denied"; reason: string };

export function parseResume(message: A2AMessage): ResumeControl | null {
  for (const part of message.parts) {
    if (part.kind !== "data") continue;
    const { grant, permission_denied, reason } = part.data;
    if (permission_denied === true)
      return { kind: "denied", reason: typeof reason === "string" ? reason : "denied by origin" };
    if (grant !== undefined) return { kind: "grant", grant: parseSignedGrant(grant) };
  }
  return null;
}
