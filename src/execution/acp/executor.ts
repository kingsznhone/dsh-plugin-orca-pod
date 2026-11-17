/**
 * AcpExecutor (§6.14): one `dsh --profile acp` child process per orca node,
 * driven over ACP v1. One ACP session per (origin orca node, context);
 * permission prompts suspend the task exactly like the Echo executor, and the
 * task's resume message answers the prompt.
 */

import type {
  PromptResponse,
  RequestPermissionResponse,
  SessionConfigOptionCategory,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";

import { CLI_PATH, IN_TASK_ENV } from "../../kernel/entry.ts";
import { errorMessage } from "../../kernel/errors.ts";
import type { NodeLogger } from "../../kernel/events.ts";
import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { describeModelRequest, type ModelDefaults } from "../../protocol/model.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor, Suspension } from "../executor.ts";
import { KILL_GRACE_MS } from "../process.ts";
import { abortError } from "../../kernel/errors.ts";
import type { AcpConnection, SessionRoute } from "./connection.ts";
import { CANCELLED, autoDecision, outcomeFor, parsePermissionRequest, type AcpPermissionAsk } from "./permissions.ts";
import type { AcpExecutorConfig } from "./config.ts";
import { createAcpSessions, type OpenSession } from "./session.ts";

/** Extra executor-local options not part of the DSH-facing config. */
type AcpExecutorOptions = AcpExecutorConfig & {
  data_root?: string;
  /**
   * Local defaults for a task that names no model or effort. ACP always gets
   * them, so a resumed session cannot keep a previous task's selection (§6.15).
   */
  modelDefaults?: () => ModelDefaults;
  logger?: NodeLogger;
};

/** Stop reasons that end a prompt without an answer (§6.14); anything else completes the task. */
const FAILED_STOP_REASONS: Partial<Record<StopReason, string>> = {
  refusal: "model refused the task",
  max_tokens: "model stopped at its token limit",
  max_turn_requests: "agent stopped at its turn limit",
};

type RunEvent =
  | { kind: "prompt-done"; result: PromptResponse }
  | { kind: "prompt-error"; error: Error }
  | { kind: "permission"; request: AcpPermissionAsk; reply: (outcome: RequestPermissionResponse) => void };

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

function textOf(update: SessionUpdate): string {
  return update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : "";
}

/** Responses are typed, not validated by the SDK: a prompt without a stop reason is a broken server. */
function stopReasonOf(result: PromptResponse | undefined): StopReason {
  if (typeof result?.stopReason !== "string") throw new Error("acp prompt returned no stopReason");
  return result.stopReason;
}

/**
 * ACP selects the model per session (§6.15) through the session's config
 * options, found by their ACP category (`model`, `thought_level`) rather than
 * by id; the ACP server rejects unknown values. The effort is
 * written only when the task (or the node default) supplies one: DeepSeek
 * models expose a fixed default effort, and dsh-acp rejects the empty
 * "provider default" value for them. Returns why it failed, or null.
 */
async function selectModel(
  session: OpenSession,
  model: ModelSelection | undefined,
  reasoningEffort: ReasoningEffortId | undefined,
): Promise<string | null> {
  const { connection, sessionId } = session;
  /** Set the option the agent files under `category`; the agent answers with its options as they are now. */
  const set = async (category: SessionConfigOptionCategory, value: string): Promise<void> => {
    const option = session.configOptions.find((candidate) => candidate.category === category);
    if (option === undefined) throw new Error(`the agent offers no "${category}" option`);
    const answer = await connection.request("session/set_config_option", { sessionId, configId: option.id, value });
    session.configOptions = answer?.configOptions ?? session.configOptions;
  };
  try {
    // dsh-acp names a model option by its route, `[provider, model]` as JSON.
    if (model !== undefined) await set("model", JSON.stringify([model.provider, model.model]));
    if (reasoningEffort !== undefined) await set("thought_level", reasoningEffort);
    return null;
  } catch (error) {
    return `cannot select ${describeModelRequest(model, reasoningEffort)}: ${errorMessage(error)}`;
  }
}

/** Replies the ACP child still waits for. */
type OpenReplies = Set<(outcome: RequestPermissionResponse) => void>;

/**
 * What one run listens for from the child: message chunks are collected into
 * the transcript; a permission the inherited mode covers is answered at once,
 * any other is queued for the origin and remembered in `open`.
 */
function makeRoute(
  input: ExecuteInput,
  events: AsyncQueue<RunEvent>,
  open: OpenReplies,
  transcript: { text: string },
): SessionRoute {
  return {
    update: (update) => {
      transcript.text += textOf(update);
    },
    permission: (params) => {
      const request = parsePermissionRequest(params);
      const decision = autoDecision(input.permissionMode, request.kind);
      if (decision !== null) return Promise.resolve(outcomeFor(request.options, decision));
      return new Promise((resolve) => {
        const reply = (outcome: RequestPermissionResponse): void => {
          open.delete(reply);
          resolve(outcome);
        };
        open.add(reply);
        events.push({ kind: "permission", request, reply });
      });
    },
  };
}

/**
 * Cancel the run when `signal` aborts: answer the waiting permissions (an
 * unanswered one would leave the child prompt waiting forever), cancel the
 * prompt, and force-close the child if this run is still attached after the
 * grace period. The child is shared with later tasks, hence the check.
 */
function armAbort(
  signal: AbortSignal,
  run: { connection: AcpConnection; sessionId: string; route: SessionRoute; open: OpenReplies },
): { wasAborted(): boolean; disarm(): void } {
  const { connection, sessionId, route, open } = run;
  let aborted = false;
  let forceClose: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    aborted = true;
    for (const reply of [...open]) reply(CANCELLED);
    connection.cancel(sessionId);
    forceClose = setTimeout(() => {
      if (connection.isAttached(sessionId, route)) void connection.close();
    }, KILL_GRACE_MS);
    forceClose.unref();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    wasAborted: () => aborted,
    disarm() {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(forceClose);
    },
  };
}

/** Suspending sets the task to input-required; coming back means the origin approved (a denial aborts the run). */
function suspensionFor(request: AcpPermissionAsk): Suspension {
  return {
    kind: "permission",
    tool: request.title,
    requested: {
      ...(request.toolCallId === undefined ? {} : { tool_call_id: request.toolCallId }),
      ...(request.kind === undefined ? {} : { tool_kind: request.kind }),
    },
  };
}

export function createAcpExecutor(options: AcpExecutorOptions = {}): LocalExecutor {
  const sessions = createAcpSessions({
    spawn: {
      command: options.command ?? "dsh",
      args: [...(options.extra_args ?? []), "--profile", options.profile ?? "acp"],
      // Sessions spawned by this executor get the CLI path for publish/fetch, and
      // the in-task marker that makes the CLI and the plugin refuse to send (§7.9).
      env: {
        ...process.env,
        [IN_TASK_ENV]: "1",
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
      const session = await sessions.open(input);
      const { connection, sessionId } = session;
      const defaults = options.modelDefaults?.();
      const failure = await selectModel(
        session,
        input.model ?? defaults?.model ?? undefined,
        input.reasoningEffort ?? defaults?.reasoningEffort ?? undefined,
      );
      if (failure !== null) {
        yield { type: "failed", text: failure, reason: "model_unavailable" };
        return;
      }

      const events = new AsyncQueue<RunEvent>();
      /** Permission requests the child still waits on; an abort answers them all. */
      const open: OpenReplies = new Set();
      const transcript = { text: "" };
      const route = makeRoute(input, events, open, transcript);
      const detach = connection.attach(sessionId, route);
      const abort = armAbort(signal, { connection, sessionId, route, open });

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
            if (abort.wasAborted() || stop === "cancelled") throw abortError();
            const reason = FAILED_STOP_REASONS[stop];
            terminal =
              reason === undefined ? { type: "completed", text: transcript.text } : { type: "failed", text: reason };
            break;
          }
          const { request, reply } = event;
          // Suspending sets the task to input-required; coming back means the
          // origin approved (a denial aborts the run instead).
          yield { type: "suspend", suspend: suspensionFor(request) };
          reply(outcomeFor(request.options, "allow"));
        }
      } finally {
        abort.disarm();
        detach();
      }
      yield terminal;
    },
  };
}
