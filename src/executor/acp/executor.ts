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

import { CLI_PATH, IN_TASK_ENV } from "../../core/entry.ts";
import { errorMessage, abortError } from "../../core/errors.ts";
import type { NodeLogger } from "../../core/events.ts";
import type { ModelCatalog } from "../../core/model-catalog.ts";
import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { describeModelRequest } from "../../core/wire/model.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor, Suspension } from "../executor.ts";
import { KILL_GRACE_MS } from "../process.ts";
import type { SessionRoute } from "./connection.ts";
import {
  CANCELLED,
  escalationFor,
  modeAllows,
  outcomeFor,
  parsePermissionRequest,
  type AcpPermissionAsk,
} from "./permissions.ts";
import type { AcpExecutorConfig } from "./config.ts";
import { AcpSessionPool, type OpenSession } from "./session.ts";

/** The DSH-facing ACP config plus what the node adds to it. */
export type AcpExecutorOptions = AcpExecutorConfig & { data_root?: string };

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

/** Suspending sets the task to input-required; coming back means the origin granted the mode (a denial aborts the run). */
function suspensionFor(request: AcpPermissionAsk, requestedMode: SandboxMode): Suspension {
  return {
    kind: "permission",
    tool: request.title,
    requested: {
      tool_call_id: request.toolCallId,
      ...(request.kind === undefined ? {} : { tool_kind: request.kind }),
    },
    requestedMode,
  };
}

/**
 * One task run on an open session. It owns what the run accumulates: the queue
 * of what the child said, the permission replies the child still waits for, the
 * transcript, the effective mode and the abort state.
 */
class AcpRun {
  private readonly events = new AsyncQueue<RunEvent>();
  /** Permission requests the child still waits on; an abort answers them all. */
  private readonly open = new Set<(outcome: RequestPermissionResponse) => void>();
  private readonly route: SessionRoute;
  private transcript = "";
  /** The run's effective mode; a grant from the origin widens it for the rest of the task (§7.12). */
  private mode: SandboxMode;
  private aborted = false;

  constructor(
    private readonly input: ExecuteInput,
    private readonly session: OpenSession,
  ) {
    this.mode = input.permissionMode;
    this.route = this.makeRoute();
  }

  /** Drive the prompt to its end; a suspension is yielded and answered with the granted mode. */
  async *drive(signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, SandboxMode | undefined> {
    const { connection, sessionId } = this.session;
    const detach = connection.attach(sessionId, this.route);
    const disarm = this.armAbort(signal);

    connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: this.input.prompt }] }).then(
      (result) => this.events.push({ kind: "prompt-done", result }),
      (error: Error) => this.events.push({ kind: "prompt-error", error }),
    );

    // The task runner never resumes a generator after a terminal event, so the
    // route is released before that event is yielded, not in a `finally` after it.
    let terminal: ExecutorEvent;
    try {
      for (;;) {
        const event = await this.events.next();
        if (event.kind === "prompt-error") throw event.error;
        if (event.kind === "prompt-done") {
          const stop = stopReasonOf(event.result);
          if (this.aborted || stop === "cancelled") throw abortError();
          const reason = FAILED_STOP_REASONS[stop];
          terminal =
            reason === undefined ? { type: "completed", text: this.transcript } : { type: "failed", text: reason };
          break;
        }
        const { request, reply } = event;
        // A grant for an earlier request may already cover one queued behind it.
        if (modeAllows(this.mode, request.kind)) {
          reply(outcomeFor(request.options, "allow"));
          continue;
        }
        const requestedMode = escalationFor(this.mode, this.input.permissionCeiling, request.kind);
        if (requestedMode === null) {
          reply(outcomeFor(request.options, "reject"));
          continue;
        }
        // Suspending sets the task to input-required; coming back means the
        // origin granted the mode (a denial aborts the run instead), and the
        // rest of the task runs under it.
        this.mode = (yield { type: "suspend", suspend: suspensionFor(request, requestedMode) }) ?? requestedMode;
        reply(outcomeFor(request.options, "allow"));
      }
    } finally {
      disarm();
      detach();
    }
    yield terminal;
  }

  /**
   * What this run listens for from the child: message chunks are collected into
   * the transcript; a permission the inherited mode covers is answered at once,
   * any other is queued for the origin and remembered in `open`.
   */
  private makeRoute(): SessionRoute {
    return {
      update: (update) => {
        this.transcript += textOf(update);
      },
      permission: (params) => {
        const request = parsePermissionRequest(params);
        if (modeAllows(this.mode, request.kind)) return Promise.resolve(outcomeFor(request.options, "allow"));
        // Past this node's ceiling nobody may allow it: refuse without asking.
        if (escalationFor(this.mode, this.input.permissionCeiling, request.kind) === null) {
          return Promise.resolve(outcomeFor(request.options, "reject"));
        }
        return new Promise((resolve) => {
          const reply = (outcome: RequestPermissionResponse): void => {
            this.open.delete(reply);
            resolve(outcome);
          };
          this.open.add(reply);
          this.events.push({ kind: "permission", request, reply });
        });
      },
    };
  }

  /**
   * Cancel the run when `signal` aborts: answer the waiting permissions (an
   * unanswered one would leave the child prompt waiting forever), cancel the
   * prompt, and force-close the child if this run is still attached after the
   * grace period. The child is shared with later tasks, hence the check.
   * Returns the function that disarms it.
   */
  private armAbort(signal: AbortSignal): () => void {
    const { connection, sessionId } = this.session;
    let forceClose: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      this.aborted = true;
      for (const reply of [...this.open]) reply(CANCELLED);
      connection.cancel(sessionId);
      forceClose = setTimeout(() => {
        if (connection.isAttached(sessionId, this.route)) void connection.close();
      }, KILL_GRACE_MS);
      forceClose.unref();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return () => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(forceClose);
    };
  }
}

export class AcpExecutor implements LocalExecutor {
  private readonly sessions: AcpSessionPool;

  constructor(
    config: AcpExecutorOptions,
    /** Local defaults for a task that names no model or effort; a resumed session must not keep an earlier task's selection (§6.15). */
    private readonly models: ModelCatalog,
    logger: NodeLogger,
  ) {
    this.sessions = new AcpSessionPool(
      {
        command: config.command ?? "dsh",
        args: [...(config.extra_args ?? []), "--profile", config.profile ?? "acp"],
        // Sessions spawned by this executor get the CLI path for publish/fetch, and
        // the in-task marker that makes the CLI and the plugin refuse to send (§7.9).
        env: {
          ...process.env,
          [IN_TASK_ENV]: "1",
          ORCA_POD_CLI: CLI_PATH,
          ...(config.data_root === undefined ? {} : { ORCA_POD_DATA_ROOT: config.data_root }),
        },
      },
      config.mcp_servers ?? [],
      logger,
    );
  }

  close(): Promise<void> {
    return this.sessions.close();
  }

  async *run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, SandboxMode | undefined> {
    const session = await this.sessions.open(input);
    const defaults = this.models.defaults();
    const failure = await selectModel(
      session,
      input.model ?? defaults.model ?? undefined,
      input.reasoningEffort ?? defaults.reasoningEffort ?? undefined,
    );
    if (failure !== null) {
      yield { type: "failed", text: failure, reason: "model_unavailable" };
      return;
    }
    yield* new AcpRun(input, session).drive(signal);
  }
}
