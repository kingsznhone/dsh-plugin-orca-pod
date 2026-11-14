/**
 * AcpExecutor (§6.15): one `dsh --profile acp` child process per orca node,
 * driven over ACP v1 (newline-delimited JSON-RPC on stdio). One ACP session
 * per (origin orca node, context); permission prompts suspend the task exactly
 * like the Echo executor, and the task's resume message answers the prompt.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AcpExecutorConfig } from "./config.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor } from "./executor.ts";
import { KILL_GRACE_MS, abortError, isCmdShim, killTree, quoteForCmd, resolveCommand } from "./process.ts";
import { readSessions, writeSessions } from "./session-store.ts";

const STDERR_TAIL = 4096;

/** Extra executor-local options not part of the DSH-facing config. */
export type AcpExecutorOptions = AcpExecutorConfig & { data_root?: string };
const PROTOCOL_VERSION = 1;

/** Absolute path of the `orca-node` CLI entry, handed to the agent in the preamble. */
const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));

/**
 * Prepend a short operator note to every prompt: the ACP agent has a shell but
 * no cluster tools, so delegation goes through the CLI (§6.15, §9.4).
 */
function promptWithPreamble(input: ExecuteInput, dataRoot: string | undefined, text: string): string {
  const who = input.selfOrcaNodeId ? ` as orca node ${input.selfOrcaNodeId}` : "";
  const cli = `node "${CLI_PATH}"`;
  const rootFlag = dataRoot === undefined ? "" : ` --data-root "${dataRoot}"`;
  return [
    `[orca-pod] You are executing task ${input.taskId}${who}.`,
    `To delegate to another orca node, use the CLI instead of raw HTTP:`,
    `  ${cli} send${rootFlag} --peer <host:port> --text - --json`,
    `Check it with: ${cli} wait${rootFlag} --peer <host:port> --task <id> --json`,
    `  (exit 0 completed, 1 failed/canceled, 2 still running, 3 needs permission)`,
    "",
    text,
  ].join("\n");
}

type JsonRpcId = number;

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type PermissionOption = { optionId?: unknown; name?: unknown; kind?: unknown };

type PermissionParams = {
  sessionId?: unknown;
  toolCall?: { toolCallId?: unknown; title?: unknown; kind?: unknown } | null;
  options?: unknown;
};

type PromptResult = { stopReason?: unknown };

type SessionUpdate = {
  sessionUpdate?: unknown;
  content?: { type?: unknown; text?: unknown } | null;
};

type RunEvent =
  | { kind: "prompt-done"; result: PromptResult }
  | { kind: "prompt-error"; error: Error }
  | { kind: "permission"; params: PermissionParams };

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

/** Minimal ACP client connection: JSON-RPC requests, notifications, and one request handler. */
class AcpConnection {
  readonly child: ChildProcess;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private nextId = 1;
  private closed = false;
  private failure: Error | null = null;
  private stderr = "";
  private requestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;

  constructor(child: ChildProcess) {
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    child.on("error", (error: Error) => this.fail(new Error(`cannot start acp server: ${error.message}`)));
    child.on("exit", (code) => {
      if (!this.closed) this.fail(new Error(`acp server exited (code ${code ?? "null"})${this.stderrSuffix()}`));
    });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line: string) => this.onLine(line));
  }

  isClosed(): boolean {
    return this.closed;
  }

  setHandlers(handlers: {
    request: (method: string, params: unknown) => Promise<unknown>;
    notification: (method: string, params: unknown) => void;
  }): void {
    this.requestHandler = handlers.request;
    this.notificationHandler = handlers.notification;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.failure) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    killTree(this.child, "SIGTERM");
    setTimeout(() => killTree(this.child, "SIGKILL"), KILL_GRACE_MS).unref?.();
    this.fail(new Error("acp connection closed"));
  }

  private stderrSuffix(): string {
    const tail = this.stderr.trim();
    return tail ? `: ${tail}` : "";
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private respond(id: unknown, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: unknown, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message } });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return; // tolerate non-protocol noise on stdout
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        const handler = this.requestHandler;
        if (handler === null) {
          this.respondError(message.id, `unsupported client method ${message.method}`);
          return;
        }
        handler(message.method, message.params)
          .then((result) => this.respond(message.id, result))
          .catch((error: unknown) => {
            this.respondError(message.id, error instanceof Error ? error.message : String(error));
          });
        return;
      }
      this.notificationHandler?.(message.method, message.params);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id as JsonRpcId);
    if (pending === undefined) return;
    this.pending.delete(message.id as JsonRpcId);
    if (message.error) {
      const text = typeof message.error.message === "string" ? message.error.message : "acp request failed";
      pending.reject(new Error(text));
    } else {
      pending.resolve(message.result);
    }
  }
}

function sessionBindingKey(input: ExecuteInput): string | null {
  if (!input.originOrcaNode || !input.contextId) return null;
  return `acp|${input.originOrcaNode}|${input.contextId}`;
}

function textOf(update: SessionUpdate): string {
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  const content = update.content;
  if (content === null || typeof content !== "object") return "";
  return content.type === "text" && typeof content.text === "string" ? content.text : "";
}

export function createAcpExecutor(options: AcpExecutorOptions = {}): LocalExecutor {
  const command = options.command ?? "dsh";
  const profile = options.profile ?? "acp";
  const extraArgs = options.extra_args ?? [];

  let connection: AcpConnection | null = null;
  let connecting: Promise<AcpConnection> | null = null;
  const activeSessions = new Map<string, string>();

  function startConnection(cwd: string): AcpConnection {
    const resolved = resolveCommand(command);
    const viaCmd = isCmdShim(resolved);
    const args = [...extraArgs, "--profile", profile];
    const child = viaCmd
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[quoteForCmd(resolved), ...args.map(quoteForCmd)].join(" ")}"`], {
          cwd,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(resolved, args, {
          cwd,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          ...(process.platform === "win32" ? {} : { detached: true }),
        });
    return new AcpConnection(child);
  }

  async function ensureConnection(cwd: string): Promise<AcpConnection> {
    if (connection !== null && !connection.isClosed()) return connection;
    if (connecting !== null) return connecting;
    connecting = (async (): Promise<AcpConnection> => {
      const next = startConnection(cwd);
      await next.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      connection = next;
      connecting = null;
      return next;
    })().catch((error: unknown) => {
      connecting = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
    return connecting;
  }

  const mcpServers = options.mcp_servers ?? [];

  async function openSession(conn: AcpConnection, key: string | null, cwd: string, podDir?: string): Promise<string> {
    if (key !== null) {
      const active = activeSessions.get(key);
      if (active !== undefined) return active;
    }
    const bindings = key !== null && podDir !== undefined ? await readSessions(podDir) : {};
    if (key !== null) {
      const bound = bindings[key];
      if (bound !== undefined) {
        try {
          await conn.request("session/resume", { sessionId: bound, cwd, mcpServers });
          activeSessions.set(key, bound);
          return bound;
        } catch {
          // not resumable any more; fall through to a fresh session
        }
      }
    }
    const created = (await conn.request("session/new", { cwd, mcpServers })) as { sessionId?: unknown };
    const sessionId = typeof created.sessionId === "string" ? created.sessionId : null;
    if (sessionId === null) throw new Error("acp server returned no session id");
    if (key !== null) {
      activeSessions.set(key, sessionId);
      if (podDir !== undefined) {
        bindings[key] = sessionId;
        await writeSessions(podDir, bindings);
      }
    }
    return sessionId;
  }

  return {
    close(): void {
      connection?.close();
      connection = null;
      connecting = null;
      activeSessions.clear();
    },

    async *run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, unknown> {
      if (!input.prompt) {
        yield { type: "failed", text: "task has no prompt text" };
        return;
      }
      const cwd = input.workspaceDir ?? process.cwd();
      const key = sessionBindingKey(input);
      let conn: AcpConnection;
      let sessionId: string;
      try {
        conn = await ensureConnection(cwd);
        sessionId = await openSession(conn, key, cwd, input.podDir);
      } catch (error) {
        yield { type: "failed", text: error instanceof Error ? error.message : String(error) };
        return;
      }

      const events = new AsyncQueue<RunEvent>();
      const permissionResolvers: Array<(value: unknown) => void> = [];
      let text = "";

      conn.setHandlers({
        request: (method, params) => {
          if (method !== "session/request_permission") {
            return Promise.reject(new Error(`unsupported client method ${method}`));
          }
          const permission = params as PermissionParams;
          events.push({ kind: "permission", params: permission });
          return new Promise((resolve) => permissionResolvers.push(resolve));
        },
        notification: (method, params) => {
          if (method !== "session/update") return;
          const update = (params as { update?: SessionUpdate } | undefined)?.update;
          if (update !== undefined && typeof update === "object") text += textOf(update);
        },
      });

      const prompt = conn.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: promptWithPreamble(input, options.data_root, input.prompt) }],
      });
      void prompt.then(
        (result) => events.push({ kind: "prompt-done", result: result as PromptResult }),
        (error: unknown) => events.push({ kind: "prompt-error", error: error instanceof Error ? error : new Error(String(error)) }),
      );

      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
        conn.notify("session/cancel", { sessionId });
        setTimeout(() => conn.close(), KILL_GRACE_MS).unref?.();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      try {
        while (true) {
          const event = await events.next();
          if (event.kind === "prompt-error") throw event.error;
          if (event.kind === "prompt-done") {
            const stop = event.result.stopReason;
            if (aborted || stop === "cancelled") throw abortError();
            if (stop === "refusal") {
              yield { type: "failed", text: "model refused the task" };
              return;
            }
            yield { type: "completed", text };
            return;
          }
          const params = event.params;
          const toolCall = params.toolCall ?? {};
          const title = typeof toolCall.title === "string" ? toolCall.title : "tool";
          // Suspending here sets the task to input-required; the resume message
          // is the origin's decision, which we translate back into ACP.
          yield {
            type: "suspend",
            suspend: {
              kind: "permission",
              tool: title,
              requested: {
                ...(typeof toolCall.toolCallId === "string" ? { tool_call_id: toolCall.toolCallId } : {}),
                ...(typeof toolCall.kind === "string" ? { tool_kind: toolCall.kind } : {}),
              },
            },
          };
          const resolver = permissionResolvers.shift();
          if (!resolver) continue;
          const options = Array.isArray(params.options) ? (params.options as PermissionOption[]) : [];
          const allow =
            options.find((option) => option.kind === "allow_once") ??
            options.find((option) => typeof option.kind === "string" && option.kind.startsWith("allow"));
          if (allow !== undefined && typeof allow.optionId === "string") {
            resolver({ outcome: { outcome: "selected", optionId: allow.optionId } });
          } else {
            resolver({ outcome: { outcome: "cancelled" } });
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
