/**
 * AcpExecutor (§6.14): one `dsh --profile acp` child process per orca node,
 * driven over ACP v1. One ACP session per (origin orca node, context);
 * permission prompts suspend the task exactly like the Echo executor, and the
 * task's resume message answers the prompt.
 */

import type { NodeLogger } from "../mesh.ts";
import { isRecord, type ModelSelection } from "../protocol.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor } from "../executor.ts";
import { KILL_GRACE_MS, abortError } from "../process.ts";
import type { AcpExecutorConfig } from "../settings.ts";
import { CLI_PATH } from "../entry.ts";
import type { AcpConnection, SessionRoute } from "./connection.ts";
import { CANCELLED, autoDecision, outcomeFor, parsePermissionRequest, type PermissionRequest } from "./permissions.ts";
import { createAcpSessions } from "./session.ts";
import { errorMessage } from "../errors.ts";

/** Extra executor-local options not part of the DSH-facing config. */
type AcpExecutorOptions = AcpExecutorConfig & {
  data_root?: string;
  /**
   * Local defaults for a task that names no model or effort. ACP always gets
   * them, so a resumed session cannot keep a previous task's selection (§6.15).
   */
  modelDefaults?: () => { model: ModelSelection | null; reasoningEffort: string | null };
  logger?: NodeLogger;
};

/** Stop reasons that end a prompt without an answer (§6.14); anything else completes the task. */
const FAILED_STOP_REASONS: Record<string, string> = {
  refusal: "model refused the task",
  max_tokens: "model stopped at its token limit",
  max_turn_requests: "agent stopped at its turn limit",
};

type RunEvent =
  | { kind: "prompt-done"; result: unknown }
  | { kind: "prompt-error"; error: Error }
  | { kind: "permission"; request: PermissionRequest; reply: (outcome: unknown) => void };

/** A small single-consumer async queue; the executor loop is the only reader. */
class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  next(): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function textOf(update: unknown): string {
  if (!isRecord(update) || update.sessionUpdate !== "agent_message_chunk" || !isRecord(update.content)) return "";
  return update.content.type === "text" && typeof update.content.text === "string" ? update.content.text : "";
}

function stopReasonOf(result: unknown): string {
  if (!isRecord(result) || typeof result.stopReason !== "string") throw new Error("acp prompt returned no stopReason");
  return result.stopReason;
}

/**
 * ACP selects the model per session (§6.15). The option value is the catalog's
 * opaque choice value; the ACP server rejects unknown values. The effort is
 * written only when the task (or the node default) supplies one: DeepSeek
 * models expose a fixed default effort, and dsh-acp rejects the empty
 * "provider default" value for them. Returns why it failed, or null.
 */
async function selectModel(
  connection: AcpConnection,
  sessionId: string,
  model: ModelSelection | undefined,
  reasoningEffort: string | undefined,
): Promise<string | null> {
  try {
    if (model !== undefined) {
      await connection.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: JSON.stringify([model.provider, model.model]),
      });
    }
    if (reasoningEffort !== undefined) {
      await connection.request("session/set_config_option", {
        sessionId,
        configId: "reasoning_effort",
        value: reasoningEffort,
      });
    }
    return null;
  } catch (error) {
    const target = [
      model === undefined ? "" : `model ${model.provider}/${model.model}`,
      reasoningEffort === undefined ? "" : `reasoning effort "${reasoningEffort}"`,
    ]
      .filter(Boolean)
      .join(" and ");
    return `cannot select ${target}: ${errorMessage(error)}`;
  }
}

export function createAcpExecutor(options: AcpExecutorOptions = {}): LocalExecutor {
  const sessions = createAcpSessions({
    spawn: {
      command: options.command ?? "dsh",
      args: [...(options.extra_args ?? []), "--profile", options.profile ?? "acp"],
      // Sessions spawned by this executor get the CLI path for the orca-node skill.
      env: {
        ...process.env,
        ORCA_POD_CLI: CLI_PATH,
        ...(options.data_root === undefined ? {} : { ORCA_POD_DATA_ROOT: options.data_root }),
      },
    },
    mcpServers: options.mcp_servers ?? [],
    logger: options.logger ?? { warn() {} },
  });

  return {
    close: sessions.close,

    async *run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, void> {
      const { connection, sessionId } = await sessions.open(input);
      const defaults = options.modelDefaults?.();
      const failure = await selectModel(
        connection,
        sessionId,
        input.model ?? defaults?.model ?? undefined,
        input.reasoningEffort ?? defaults?.reasoningEffort ?? undefined,
      );
      if (failure !== null) {
        yield { type: "failed", text: failure, reason: "model_unavailable" };
        return;
      }

      const events = new AsyncQueue<RunEvent>();
      /** Permission requests the child still waits on; an abort answers them all. */
      const open = new Set<(outcome: unknown) => void>();
      let text = "";
      const route: SessionRoute = {
        update: (update) => {
          text += textOf(update);
        },
        permission: (params) => {
          const request = parsePermissionRequest(params);
          const decision = autoDecision(input.permissionMode, request.kind);
          if (decision !== null) return Promise.resolve(outcomeFor(request.options, decision));
          return new Promise((resolve) => {
            const reply = (outcome: unknown): void => {
              open.delete(reply);
              resolve(outcome);
            };
            open.add(reply);
            events.push({ kind: "permission", request, reply });
          });
        },
      };
      const detach = connection.attach(sessionId, route);

      let aborted = false;
      let forceClose: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        aborted = true;
        // Aborting without answering would leave the child prompt waiting forever.
        for (const reply of [...open]) reply(CANCELLED);
        connection.notify("session/cancel", { sessionId });
        // The child is shared with later tasks: force-close it only if this run
        // is still the one attached after the grace period.
        forceClose = setTimeout(() => {
          if (connection.isAttached(sessionId, route)) void connection.close();
        }, KILL_GRACE_MS);
        forceClose.unref();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: input.prompt }] }).then(
        (result) => events.push({ kind: "prompt-done", result }),
        (error: Error) => events.push({ kind: "prompt-error", error }),
      );

      // The task runner never resumes a generator after a terminal event, so the
      // route is released before that event is yielded, not in a `finally` after it.
      let terminal: ExecutorEvent;
      try {
        for (;;) {
          const event = await events.next();
          if (event.kind === "prompt-error") throw event.error;
          if (event.kind === "prompt-done") {
            const stop = stopReasonOf(event.result);
            if (aborted || stop === "cancelled") throw abortError();
            const reason = FAILED_STOP_REASONS[stop];
            terminal = reason === undefined ? { type: "completed", text } : { type: "failed", text: reason };
            break;
          }
          const { request, reply } = event;
          // Suspending sets the task to input-required; coming back means the
          // origin approved (a denial aborts the run instead).
          yield {
            type: "suspend",
            suspend: {
              kind: "permission",
              tool: request.title,
              requested: {
                ...(request.toolCallId === undefined ? {} : { tool_call_id: request.toolCallId }),
                ...(request.kind === undefined ? {} : { tool_kind: request.kind }),
              },
            },
          };
          reply(outcomeFor(request.options, "allow"));
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        clearTimeout(forceClose);
        detach();
      }
      yield terminal;
    },
  };
}
