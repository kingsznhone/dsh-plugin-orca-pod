/**
 * AcpExecutor (§6.14): one `dsh` child process per orca node, driven over ACP
 * v1. One ACP session per (origin orca node, context), resumed from the
 * persisted binding when the child still knows it; a permission prompt
 * suspends the task, and the task's resume message answers the prompt.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import {
  RequestError,
  type ErrorCode,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type StopReason,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { z } from "zod";

import { abortError, errorMessage, isMissingFile } from "../../core/errors.ts";
import type { NodeLogger } from "../../core/events.ts";
import { parseOrThrow } from "../../core/schema.ts";
import type { ModelCatalog } from "../model-catalog.ts";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { ExecuteInput, ExecutorEvent, LocalExecutor, Suspension } from "../executor.ts";
import { AcpConnection, HANDSHAKE_TIMEOUT_MS, KILL_GRACE_MS, type SessionRoute } from "./connection.ts";
import { CANCELLED, escalationFor, modeAllows, outcomeFor } from "./permissions.ts";
import { AcpSession } from "./session.ts";

/** JSON-RPC code ACP agents use for a session they do not know. */
const RESOURCE_NOT_FOUND: ErrorCode = -32002;

/**
 * Executor session bindings persisted under `<data_root>/state/<workgroup>/sessions.json`
 * (the task's `podDir`): session key → ACP session id.
 */
const SessionBindingsSchema = z.record(z.string(), z.string());
type SessionBindings = z.infer<typeof SessionBindingsSchema>;

/**
 * Environment variable the task executor sets to "1" in every session it
 * spawns. An agent running a task must not start another one: tasks are
 * single-hop (§7.9), so the plugin's `send` refuses while it is set. This keeps
 * a well-behaved agent from cascading; it is not a security boundary, since the
 * agent runs as the same OS user as the node.
 */
export const IN_TASK_ENV = "ORCA_POD_IN_TASK";

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
  /** The run's effective mode; the origin's approval widens it for the rest of the task (§7.12). */
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
  async *drive(signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, void> {
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
        // An approval of an earlier request may already cover one queued behind it.
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
        // origin granted exactly the mode asked for (a denial aborts the run
        // instead), and the rest of the task runs under it.
        yield AcpRun.suspensionFor(toolCall, requestedMode);
        this.mode = requestedMode;
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
      type: "suspend",
      tool: toolCall.title ?? "tool",
      requested: {
        tool_call_id: toolCall.toolCallId,
        ...(toolCall.kind == null ? {} : { tool_kind: toolCall.kind }),
      },
      requestedMode,
    };
  }
}

/**
 * ACP executor options (§6.14): the `dsh` stdio server to start. The child always
 * runs the `acp` profile, which must load this plugin too so the task agent can
 * exchange files (D60). Part of the node's settings (`node/settings.ts`).
 */
export const AcpExecutorConfigSchema = z.object({ command: z.string().min(1).optional() });
export type AcpExecutorConfig = z.infer<typeof AcpExecutorConfigSchema>;

export class AcpExecutor implements LocalExecutor {
  private readonly command: string;
  private readonly args: string[];
  /** What the task's plugin needs to reach this machine's node, read when the child starts. */
  private readonly childEnv: () => Record<string, string>;
  /** Session ids belong to one connection: a fresh child cannot resume ids cached for the old one. */
  private current: { connection: AcpConnection; sessions: Map<string, AcpSession> } | null = null;

  constructor(
    config: AcpExecutorConfig,
    /** Local defaults for a task that names no model or effort; a resumed session must not keep an earlier task's selection (§6.15). */
    private readonly models: ModelCatalog,
    private readonly logger: NodeLogger,
    child: {
      /** What the task's plugin needs to reach this machine's node, read when the child starts. */
      env: () => Record<string, string>;
    },
  ) {
    this.command = config.command ?? "dsh";
    // The acp profile is the only profile that speaks ACP on stdio. It must load
    // this plugin too: the task agent gets `orca_pod`'s file methods there (D60).
    this.args = ["--profile", "acp"];
    this.childEnv = child.env;
  }

  /** Close the connection; resolves once its child has exited. */
  async close(): Promise<void> {
    const closing = this.current?.connection.close();
    this.current = null;
    await closing;
  }

  async *run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, void> {
    const session = await this.open(input);
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

  /** The session of the task's (origin, context): the live one, the persisted one if the child still knows it, or a new one. */
  private async open(input: ExecuteInput): Promise<AcpSession> {
    const cwd = input.workspaceDir;
    const { connection, sessions } = await this.connect(cwd);
    const key = `acp|${input.originOrcaNode}|${input.contextId}`;
    const active = sessions.get(key);
    if (active !== undefined) return active;

    const bindingsPath = join(input.podDir, "sessions.json");
    const bindings = await AcpExecutor.loadBindings(bindingsPath);
    const bound = bindings[key];
    const resumed = bound === undefined ? null : await this.resume(connection, bound, cwd);
    if (bound !== undefined && resumed !== null) {
      const session = new AcpSession(connection, bound, resumed);
      sessions.set(key, session);
      return session;
    }
    const created = await connection.request("session/new", { cwd, mcpServers: [] }, HANDSHAKE_TIMEOUT_MS);
    // Responses are typed, not validated: a broken server must not bind `undefined`.
    if (typeof created?.sessionId !== "string") throw new Error("acp server returned no session id");
    const session = new AcpSession(connection, created.sessionId, created.configOptions ?? []);
    sessions.set(key, session);
    bindings[key] = created.sessionId;
    await writeFileAtomic(bindingsPath, `${JSON.stringify(bindings, null, 2)}\n`, { mode: 0o600 });
    return session;
  }

  private async connect(cwd: string): Promise<{ connection: AcpConnection; sessions: Map<string, AcpSession> }> {
    if (this.current === null || this.current.connection.isClosed()) {
      // Sessions spawned by this executor carry the in-task marker: the plugin there
      // starts no node and offers only the file methods, through this node (§7.9, §5.6).
      const env = { ...process.env, ...this.childEnv(), [IN_TASK_ENV]: "1" };
      this.current = { connection: AcpConnection.spawn(this.command, this.args, cwd, env), sessions: new Map() };
    }
    const joined = this.current;
    await joined.connection.ready;
    return joined;
  }

  /** The session's config options after a resume; null when the agent no longer knows it. */
  private async resume(
    connection: AcpConnection,
    sessionId: string,
    cwd: string,
  ): Promise<SessionConfigOption[] | null> {
    try {
      const resumed = await connection.request(
        "session/resume",
        { sessionId, cwd, mcpServers: [] },
        HANDSHAKE_TIMEOUT_MS,
      );
      return resumed?.configOptions ?? [];
    } catch (error) {
      if (!(error instanceof RequestError && error.code === RESOURCE_NOT_FOUND)) {
        this.logger.warn(`acp session/resume failed, starting a new session: ${errorMessage(error)}`);
      }
      return null;
    }
  }

  /** Missing file means no bindings yet; a corrupt one throws instead of being overwritten by the next write. */
  private static async loadBindings(path: string): Promise<SessionBindings> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
    return parseOrThrow(
      SessionBindingsSchema,
      JSON.parse(text),
      (problem) => new Error(`${path} is not a map of session ids: ${problem}`),
    );
  }
}
