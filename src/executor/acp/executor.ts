/**
 * AcpExecutor (§6.14): one `dsh --profile acp` child process per orca node,
 * driven over ACP v1. One ACP session per (origin orca node, context);
 * permission prompts suspend the task exactly like the Echo executor, and the
 * task's resume message answers the prompt.
 */

import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

import { IN_TASK_ENV } from "../../core/entry.ts";
import { abortError } from "../../core/errors.ts";
import type { NodeLogger } from "../../core/events.ts";
import type { ModelCatalog } from "../model-catalog.ts";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { ExecuteInput, ExecutorEvent, LocalExecutor, Suspension } from "../executor.ts";
import { KILL_GRACE_MS, type SessionRoute } from "./connection.ts";
import { CANCELLED, escalationFor, modeAllows, outcomeFor } from "./permissions.ts";
import type { AcpExecutorConfig } from "./config.ts";
import { AcpSessionPool, type AcpSession } from "./session.ts";

/** Stop reasons that end a prompt without an answer (§6.14); anything else completes the task. */
const FAILED_STOP_REASONS: Partial<Record<StopReason, string>> = {
  refusal: "model refused the task",
  max_tokens: "model stopped at its token limit",
  max_turn_requests: "agent stopped at its turn limit",
};

type RunEvent =
  | { kind: "prompt-done"; result: PromptResponse }
  | { kind: "prompt-error"; error: Error }
  | { kind: "permission"; request: RequestPermissionRequest; reply: (outcome: RequestPermissionResponse) => void };

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
    private readonly session: AcpSession,
  ) {
    this.mode = input.permissionMode;
    this.route = this.makeRoute();
  }

  /** Drive the prompt to its end; a suspension is yielded and answered with the granted mode. */
  async *drive(signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, SandboxMode | undefined> {
    const detach = this.session.connection.attach(this.session.id, this.route);
    const disarm = this.armAbort(signal);

    this.session.prompt(this.input.prompt).then(
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
          // Responses are typed, not validated by the SDK: a prompt without a stop reason is a broken server.
          const stop = event.result?.stopReason;
          if (typeof stop !== "string") throw new Error("acp prompt returned no stopReason");
          if (this.aborted || stop === "cancelled") throw abortError();
          const reason = FAILED_STOP_REASONS[stop];
          terminal =
            reason === undefined ? { type: "completed", text: this.transcript } : { type: "failed", text: reason };
          break;
        }
        const { request, reply } = event;
        const { toolCall, options } = request;
        // A grant for an earlier request may already cover one queued behind it.
        if (modeAllows(this.mode, toolCall.kind)) {
          reply(outcomeFor(options, "allow"));
          continue;
        }
        const requestedMode = escalationFor(this.mode, this.input.permissionCeiling, toolCall.kind);
        if (requestedMode === null) {
          reply(outcomeFor(options, "reject"));
          continue;
        }
        // Suspending sets the task to input-required; coming back means the
        // origin granted the mode (a denial aborts the run instead), and the
        // rest of the task runs under it.
        this.mode =
          (yield { type: "suspend", suspend: AcpRun.suspensionFor(toolCall, requestedMode) }) ?? requestedMode;
        reply(outcomeFor(options, "allow"));
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
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          this.transcript += update.content.text;
        }
      },
      permission: (request) => {
        const { toolCall, options } = request;
        if (modeAllows(this.mode, toolCall.kind)) return Promise.resolve(outcomeFor(options, "allow"));
        // Past this node's ceiling nobody may allow it: refuse without asking.
        if (escalationFor(this.mode, this.input.permissionCeiling, toolCall.kind) === null) {
          return Promise.resolve(outcomeFor(options, "reject"));
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
    let forceClose: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      this.aborted = true;
      for (const reply of [...this.open]) reply(CANCELLED);
      // The child answers the prompt with `cancelled`; one that does not is killed, with
      // every session it serves, unless the next task already took the connection over.
      const { connection, id } = this.session;
      connection.cancel(id);
      forceClose = setTimeout(() => {
        if (connection.isAttached(id, this.route)) void connection.close();
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

  /** Suspending sets the task to input-required; coming back means the origin granted the mode (a denial aborts the run). */
  private static suspensionFor(toolCall: ToolCallUpdate, requestedMode: SandboxMode): Suspension {
    return {
      kind: "permission",
      tool: toolCall.title ?? "tool",
      requested: {
        tool_call_id: toolCall.toolCallId,
        ...(toolCall.kind == null ? {} : { tool_kind: toolCall.kind }),
      },
      requestedMode,
    };
  }
}

export class AcpExecutor implements LocalExecutor {
  private readonly sessions: AcpSessionPool;

  constructor(
    config: AcpExecutorConfig,
    /** Local defaults for a task that names no model or effort; a resumed session must not keep an earlier task's selection (§6.15). */
    private readonly models: ModelCatalog,
    logger: NodeLogger,
    child: {
      /** The host's own DSH profile, so the task has this plugin; unset passes no `--profile` (D46). */
      profile: string | undefined;
      /** What the task's plugin needs to reach this machine's node, read when the child starts. */
      env: () => Record<string, string>;
    },
  ) {
    this.sessions = new AcpSessionPool(
      {
        command: config.command ?? "dsh",
        args: [...(config.extra_args ?? []), ...(child.profile === undefined ? [] : ["--profile", child.profile])],
        // Sessions spawned by this executor carry the in-task marker: the plugin there
        // starts no node and offers only the file methods, through this node (§7.9, §5.6).
        env: () => ({ ...process.env, ...child.env(), [IN_TASK_ENV]: "1" }),
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
    const failure = await session.selectModel(
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
