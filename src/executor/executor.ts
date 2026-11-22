/**
 * The executor contract (design.md 5.1): what the task runner hands an executor and the
 * events it gets back. The node's implementation is `acp/executor.ts`; tests bring their own.
 */

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { z } from "zod";

import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

import type { OrcaNodeId } from "../core/ids.ts";

/**
 * What a permission request asks to do: the ACP tool call and its kind, when
 * the executor knows them, plus whatever else the executor describes.
 */
export const RequestedAccessSchema = z.looseObject({
  tool_call_id: z.string().optional(),
  tool_kind: z.string().optional(),
});
type RequestedAccess = z.infer<typeof RequestedAccessSchema>;

/**
 * A running task stops to wait for a permission decision from the origin
 * (design.md 6.4): one tool call needs more than the task's mode allows. That is the
 * only reason it waits. An executor that cannot continue for any other reason
 * finishes instead, with `BLOCKED: …` as the first line of its result (design.md 5.2);
 * there is no "ask the origin a question" suspension.
 */
export type Suspension = {
  type: "suspend";
  tool: string;
  requested: RequestedAccess;
  /** The narrowest mode that would allow it; the task asks the origin to continue with it. */
  requestedMode: SandboxMode;
};

export type ExecutorEvent =
  | Suspension
  | { type: "completed"; text: string }
  | { type: "failed"; text: string; reason?: string };

export type ExecuteInput = {
  contextId: string;
  /** The full prompt: trusted preamble, then the origin's text as untrusted data. */
  prompt: string;
  /** Origin orca node; part of the session binding key (design.md 5.4). */
  originOrcaNode: OrcaNodeId;
  /** Group workspace root `<data_root>/workgroups/<workgroup_id>`; the executor's cwd (design.md 5.4). */
  workspaceDir: string;
  /** Gateway state dir `<data_root>/state/<workgroup_id>` (session bindings); outside the cwd (design.md 5.4). */
  podDir: string;
  /** Effective permission mode after origin inheritance and local ceiling (design.md 6.4). */
  permissionMode: SandboxMode;
  /** This node's own ceiling; a task never asks to be upgraded past it. Unset means no local ceiling. */
  permissionCeiling: SandboxMode | undefined;
  /** Model route the origin asks for; an executor that cannot select one fails the task (design.md 5.6). */
  model: ModelSelection | undefined;
  /** Reasoning effort for that route, same rule. */
  reasoningEffort: ReasoningEffortId | undefined;
};

export interface LocalExecutor {
  /**
   * Run one task. After a `suspend` event the task runner resumes the
   * generator once the origin approved; the run continues with the mode it asked for.
   */
  run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, void>;
  /** Optional teardown for executors that keep a long-lived child process; resolves once it has exited. */
  close?(): Promise<void>;
}
