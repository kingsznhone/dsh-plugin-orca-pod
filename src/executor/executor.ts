/**
 * The executor contract (§6.1): what the task runner hands an executor and the
 * events it gets back. Implementations live in `echo.ts` and `acp/executor.ts`.
 */

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { z } from "zod";

import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

import type { OrcaNodeId } from "../core/ids.ts";
import { SandboxModeSchema } from "./permission.ts";

/**
 * What a permission request asks to do: the ACP tool call and its kind, when
 * the executor knows them, plus whatever else the executor describes.
 */
export const RequestedAccessSchema = z.looseObject({
  tool_call_id: z.string().optional(),
  tool_kind: z.string().optional(),
});
export type RequestedAccess = z.infer<typeof RequestedAccessSchema>;

const ECHO_LIMITS = {
  max_steps: 8,
  max_total_ms: 60_000,
  max_text_bytes: 8 * 1024,
} as const;

/** A string that is at most `max` bytes in UTF-8. */
const boundedText = (max: number) =>
  z.string().refine((text) => Buffer.byteLength(text, "utf8") <= max, `must be <= ${max} bytes`);

const EchoSuspendSchema = z.strictObject({
  kind: z.literal("permission", 'must be "permission"'),
  tool: z.string(),
  requested: RequestedAccessSchema,
  /** The mode the scripted task asks to be upgraded to. */
  mode: SandboxModeSchema.default("danger-full-access"),
});

const EchoStepSchema = z.strictObject({
  at_ms: z
    .number("must be a non-negative integer")
    .int("must be a non-negative integer")
    .min(0, "must be a non-negative integer")
    .max(ECHO_LIMITS.max_total_ms, `must be <= ${ECHO_LIMITS.max_total_ms}`),
  suspend: EchoSuspendSchema,
});

const EchoFinalSchema = z.strictObject({
  state: z.enum(["completed", "failed", "hang"], 'must be "completed", "failed" or "hang"'),
  text: boundedText(ECHO_LIMITS.max_text_bytes).default(""),
});

/**
 * An echo script: when to suspend for a permission and how the task ends. It
 * rides in `metadata.echo`, so it is a wire shape:
 * anything unknown, out of order or over a limit is refused (§6.3).
 */
export const EchoScriptSchema = z.strictObject({
  steps: z
    .array(EchoStepSchema)
    .max(ECHO_LIMITS.max_steps, `must be <= ${ECHO_LIMITS.max_steps}`)
    .refine(
      (steps) => steps.every((step, index) => index === 0 || step.at_ms > (steps[index - 1]?.at_ms ?? -1)),
      "at_ms must strictly increase",
    )
    .default([]),
  final: EchoFinalSchema.default({ state: "completed", text: "echo" }),
});
export type EchoScript = z.output<typeof EchoScriptSchema>;

/**
 * Why a running task stops to wait for someone else. The only reason is a
 * permission decision from the origin (§7.11). An executor that cannot continue
 * for any other reason finishes instead, with `BLOCKED: …` as the first line of
 * its result (§6.14); there is no "ask the origin a question" suspension.
 */
export type Suspension = {
  kind: "permission";
  tool: string;
  requested: RequestedAccess;
  /** The narrowest mode that would allow it; the task asks the origin to continue with it. */
  requestedMode: SandboxMode;
};

export type ExecutorEvent =
  | { type: "suspend"; suspend: Suspension }
  | { type: "completed"; text: string }
  | { type: "failed"; text: string; reason?: string };

export type ExecuteInput = {
  contextId: string;
  /** The full prompt: trusted preamble, then the origin's text as untrusted data. */
  prompt: string;
  /** Origin orca node; part of the session binding key (§6.10). */
  originOrcaNode: OrcaNodeId;
  /** Group workspace root `<data_root>/workgroups/<workgroup_id>`; the executor's cwd (§6.7). */
  workspaceDir: string;
  /** Gateway state dir `<data_root>/state/<workgroup_id>` (session bindings); outside the cwd (§6.7). */
  podDir: string;
  /** Effective permission mode after origin inheritance and local ceiling (§7.10). */
  permissionMode: SandboxMode;
  /** This node's own ceiling; a task never asks to be upgraded past it. Unset means no local ceiling. */
  permissionCeiling: SandboxMode | undefined;
  /** Model route the origin asks for; an executor that cannot select one fails the task (§6.15). */
  model: ModelSelection | undefined;
  /** Reasoning effort for that route, same rule. */
  reasoningEffort: ReasoningEffortId | undefined;
  /** The task's echo script (§6.3); only the echo executor reads it. */
  echo: EchoScript;
};

export interface LocalExecutor {
  /**
   * Run one task. After a `suspend` event the task runner resumes the
   * generator with the mode the origin granted; the run continues under it.
   */
  run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, SandboxMode | undefined>;
  /** Optional teardown for executors that keep a long-lived child process; resolves once it has exited. */
  close?(): Promise<void>;
}
