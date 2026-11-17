/**
 * The executor contract (§6.1): what the task runner hands an executor and the
 * events it gets back. Implementations live in `echo.ts` and `acp/executor.ts`.
 */

import type { EchoScript } from "./echo.ts";
import type { ModelSelection, ReasoningEffort } from "../protocol/model.ts";
import type { PermissionMode } from "../protocol/permission.ts";
import type { RequestedAccess, TaskRelay } from "../protocol/grant.ts";

/**
 * Why a running task stops to wait for someone else. The only reason is a
 * permission decision from the origin (§7.11). An executor that cannot continue
 * for any other reason finishes instead, with `BLOCKED: …` as the first line of
 * its result (§6.14); there is no "ask the origin a question" suspension.
 *
 * `relay` names the child task whose permission request this one passes on: the
 * task runner turns it into this node's own `permission_request` without a
 * network call (§7.12).
 */
export type Suspension = { kind: "permission"; tool: string; requested: RequestedAccess; relay?: TaskRelay };

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
  originOrcaNode: string;
  /** This orca node (the executor's host). */
  selfOrcaNodeId: string;
  /** Group workspace `work/` dir; the executor's cwd (§6.7). */
  workspaceDir: string;
  /** Group workspace `.pod/` dir; executors keep their own state here. */
  podDir: string;
  /** Effective permission mode after origin inheritance and local ceiling (§7.10). */
  permissionMode: PermissionMode;
  /** Model route the origin asks for; an executor that cannot select one fails the task (§6.15). */
  model: ModelSelection | undefined;
  /** Reasoning effort for that route, same rule. */
  reasoningEffort: ReasoningEffort | undefined;
  /** The task's echo script (§6.3); only the echo executor reads it. */
  echo: EchoScript;
};

export interface LocalExecutor {
  run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, void>;
  /** Optional teardown for executors that keep a long-lived child process; resolves once it has exited. */
  close?(): Promise<void>;
}
