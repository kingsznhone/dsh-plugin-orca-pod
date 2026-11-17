/**
 * The task's `metadata` is untrusted input from another node. It is parsed once,
 * when the task is submitted, into the typed `TaskMeta` the rest of the task
 * code uses; nothing downstream re-reads the raw metadata.
 */

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { parseEchoScript, type EchoScript } from "../execution/echo.ts";
import { PodError } from "../kernel/errors.ts";
import { describeIssue, isRecord, parseSchema } from "../kernel/schema.ts";
import { PodTaskMetadataSchema, type A2AMessage } from "../protocol/task.ts";
import type { ModelSelection, ReasoningEffort } from "../protocol/model.ts";
import type { SignedGrant } from "../protocol/grant.ts";
import { parseSignedGrant } from "../security/grants.ts";

export type TaskMeta = {
  /** What the origin session allows; a task that names no mode runs read-only (§7.10). */
  permissionMode: SandboxMode;
  model: ModelSelection | undefined;
  /** The `reasoning_effort` field, else the effort pinned in `model` (§6.15). */
  effort: ReasoningEffort | undefined;
  /** Origin's requested lifetime in seconds; the local cap still applies. */
  taskTtlS: number | undefined;
  echo: EchoScript;
};

/** Validate the `pod` block and the echo script of an incoming task (§5.1, §6.3, §8.6). */
export function parsePodMetadata(
  /** Untrusted: it is whatever the caller sent, so it is typed as nothing more than an object. */
  metadata: Record<string, unknown> | undefined,
): TaskMeta {
  const raw = metadata?.pod ?? {};
  if (!isRecord(raw)) throw new PodError("bad_request", "metadata.pod must be an object");
  const parsed = parseSchema(PodTaskMetadataSchema, raw);
  if (!parsed.ok) throw new PodError("bad_request", `pod.${describeIssue(parsed.issue)}`);
  const { permission_mode, model, reasoning_effort, task_ttl_s } = parsed.value;
  return {
    permissionMode: permission_mode ?? "read-only",
    model,
    effort: reasoning_effort ?? model?.reasoning_effort,
    taskTtlS: task_ttl_s,
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
