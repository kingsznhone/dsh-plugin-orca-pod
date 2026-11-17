/**
 * The task's `metadata` is untrusted input from another node. It is parsed once,
 * when the task is submitted, into the typed `TaskMeta` the rest of the task
 * code uses; nothing downstream re-reads the raw metadata.
 */

import { z } from "zod";

import { parseEchoScript, type EchoScript } from "../execution/echo.ts";
import { PodError } from "../kernel/errors.ts";
import { describeIssue, isRecord, parseSchema } from "../kernel/schema.ts";
import { PodTaskMetadataSchema, type A2AMessage, type TaskInputRef } from "../protocol/task.ts";
import type { ModelSelection, ReasoningEffort } from "../protocol/model.ts";
import type { PermissionMode } from "../protocol/permission.ts";
import type { SignedGrant } from "../protocol/grant.ts";
import { parseSignedGrant } from "../security/grants.ts";
import type { OrcaNodeId } from "../protocol/peer.ts";

export type TaskMeta = {
  /** Orca nodes this task was delegated through, origin first. */
  chain: OrcaNodeId[];
  /** Origin of the whole delegation tree; a root task is its own tree's origin (§7.11). */
  rootOrigin: OrcaNodeId;
  /** What the origin session allows; a task that names no mode runs read-only (§7.10). */
  permissionMode: PermissionMode;
  model: ModelSelection | undefined;
  /** The `reasoning_effort` field, else the effort pinned in `model` (§6.15). */
  effort: ReasoningEffort | undefined;
  /** Origin's requested lifetime in seconds; the local cap still applies. */
  taskTtlS: number | undefined;
  inputs: TaskInputRef[];
  echo: EchoScript;
};

/** What this node accepts as an input: a sha256 blob id under a plain file name (§6.7). */
const AcceptedInputSchema = z.object({
  blob_id: z.string().regex(/^[0-9a-f]{64}$/, "must be a sha256 blob id"),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "is not a safe file name"),
});

/** The wire `pod` block, with the one field this node narrows further. */
const AcceptedPodSchema = PodTaskMetadataSchema.extend({ inputs: z.array(AcceptedInputSchema).optional() });

function parseInputs(inputs: readonly TaskInputRef[]): TaskInputRef[] {
  const seen = new Set<string>();
  for (const { name } of inputs) {
    if (seen.has(name)) throw new PodError("duplicate_input_name", `input name ${name} appears twice`);
    seen.add(name);
  }
  return [...inputs];
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
  /** Untrusted: it is whatever the caller sent, so it is typed as nothing more than an object. */
  metadata: Record<string, unknown> | undefined,
  selfOrcaNodeId: OrcaNodeId,
  originOrcaNode: OrcaNodeId,
): TaskMeta {
  const raw = metadata?.pod ?? {};
  if (!isRecord(raw)) throw new PodError("bad_request", "metadata.pod must be an object");
  const parsed = parseSchema(AcceptedPodSchema, raw);
  if (!parsed.ok) throw new PodError("bad_request", `pod.${describeIssue(parsed.issue)}`);
  const { chain = [], root_origin, permission_mode, model, reasoning_effort, task_ttl_s, inputs } = parsed.value;
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
  return {
    chain,
    rootOrigin: root_origin ?? originOrcaNode,
    permissionMode: permission_mode ?? "read-only",
    model,
    effort: reasoning_effort ?? model?.reasoning_effort,
    taskTtlS: task_ttl_s,
    inputs: inputs === undefined ? [] : parseInputs(inputs),
    echo: parseEchoScript(metadata?.echo),
  };
}

/** The human decision a resume message carries; null when it carries none. */
export type ParsedResume = { kind: "grant"; grant: SignedGrant } | { kind: "denied"; reason: string };

export function parseResume(message: A2AMessage): ParsedResume | null {
  for (const part of message.parts) {
    if (part.kind !== "data") continue;
    const { grant, permission_denied, reason } = part.data;
    if (permission_denied === true)
      return { kind: "denied", reason: typeof reason === "string" ? reason : "denied by origin" };
    if (grant !== undefined) return { kind: "grant", grant: parseSignedGrant(grant) };
  }
  return null;
}
