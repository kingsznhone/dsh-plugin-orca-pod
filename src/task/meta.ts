/**
 * The task's `metadata` is untrusted input from another node. The gateway checks
 * it against `TaskMetadataSchema`; on submit it becomes the `TaskMeta` the rest
 * of the task code uses, and nothing downstream re-reads the raw metadata.
 */

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { parseEchoScript } from "../executor/echo.ts";
import type { EchoScript } from "../executor/executor.ts";
import type { A2AMessage, TaskMetadata } from "./wire.ts";
import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { SignedGrant } from "../core/wire/grant.ts";
import { PodError } from "../core/errors.ts";
import { describeIssue, parseSchema } from "../core/schema.ts";
import { SignedGrantSchema } from "../core/wire/grant.ts";

export type TaskMeta = {
  /** What the origin session allows; a task that names no mode runs read-only (§7.10). */
  permissionMode: SandboxMode;
  model: ModelSelection | undefined;
  /** The `reasoning_effort` field, else the effort pinned in `model` (§6.15). */
  effort: ReasoningEffortId | undefined;
  /** Origin's requested lifetime in seconds; the local cap still applies. */
  taskTtlS: number | undefined;
  echo: EchoScript;
};

/**
 * Read the `pod` block and the echo script of an incoming task (§5.1, §6.3,
 * §8.6). The gateway has already checked the metadata against
 * `TaskMetadataSchema`; the echo script is checked here, by its executor's parser.
 */
export function parsePodMetadata(metadata: TaskMetadata | undefined): TaskMeta {
  const { permission_mode, model, reasoning_effort, task_ttl_s } = metadata?.pod ?? {};
  return {
    permissionMode: permission_mode ?? "read-only",
    model,
    effort: reasoning_effort ?? model?.reasoningEffort,
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
    if (grant !== undefined) {
      // A grant crosses the trust boundary here; its signature is checked later, by `GrantLedger.accept`.
      const parsed = parseSchema(SignedGrantSchema, grant);
      if (!parsed.ok) throw new PodError("bad_request", `grant ${describeIssue(parsed.issue)}`);
      return { kind: "grant", grant: parsed.value };
    }
  }
  return null;
}
