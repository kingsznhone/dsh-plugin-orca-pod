/**
 * The executor contract (§6.1): what the task runner hands an executor and the
 * events it gets back. Implementations live in `echo.ts` and `acp/executor.ts`.
 */

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { EchoScript } from "./echo.ts";
import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { RequestedAccess } from "../core/wire/grant.ts";
import type { OrcaNodeId } from "../core/wire/peer.ts";

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
  | { type: "artifact"; name: string; content: string }
  | { type: "completed"; text: string }
  | { type: "failed"; text: string; reason?: string };

export type ExecuteInput = {
  taskId: string;
  contextId: string;
  /** The full prompt: trusted preamble, input and notes lists, then the origin's text as untrusted data. */
  prompt: string;
  /** Origin orca node; part of the session binding key (§6.10). */
  originOrcaNode: OrcaNodeId;
  /** This orca node (the executor's host). */
  selfOrcaNodeId: OrcaNodeId;
  /** Group workspace root `<data_root>/workgroups/<workgroup_id>`; the executor's cwd (§6.7). */
  workspaceDir: string;
  /** Gateway state dir `<data_root>/state/<workgroup_id>` (session bindings, artifacts); outside the cwd (§6.7). */
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
