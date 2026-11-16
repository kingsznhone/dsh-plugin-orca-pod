/**
 * JSON-RPC over the stdio of one `dsh --profile acp` child (newline-delimited).
 * The connection owns the child's lifetime: a failure of any kind closes it and
 * terminates the process, and requests from the child are routed to the run
 * that owns the named session.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isRecord } from "../protocol.ts";
import { isCmdShim, quoteForCmd, resolveCommand, terminateChild } from "../process.ts";
import { errorMessage } from "../errors.ts";

const PROTOCOL_VERSION = 1;
const STDERR_TAIL = 4096;
/** The handshake must not hang a task forever if the child is wedged. */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type AcpChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** The child answered a request with a JSON-RPC error. */
export class AcpRpcError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/** What one run does with the messages the child addresses to its session. */
export type SessionRoute = {
  update(update: unknown): void;
  permission(params: Record<string, unknown>): Promise<unknown>;
};

type ConnectionState = { status: "starting" } | { status: "ready" } | { status: "closed"; error: Error };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type AcpSpawnSpec = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

export function spawnAcpChild({ command, args, cwd, env }: AcpSpawnSpec): AcpChild {
  const resolved = resolveCommand(command);
  // A Windows `.cmd` shim cannot be spawned directly; go through cmd.exe deliberately.
  const viaCmd = isCmdShim(resolved);
  return spawn(
    viaCmd ? (process.env.ComSpec ?? "cmd.exe") : resolved,
    viaCmd ? ["/d", "/s", "/c", `"${[quoteForCmd(resolved), ...args.map(quoteForCmd)].join(" ")}"`] : args,
    {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: viaCmd,
      detached: process.platform !== "win32", // a process group, so the whole tree can be signalled
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

export class AcpConnection {
  /** Settles when `initialize` succeeded; rejects, with the connection closed, when it did not. */
  readonly ready: Promise<void>;
  private state: ConnectionState = { status: "starting" };
  private readonly child: AcpChild;
  private readonly pending = new Map<number, Pending>();
  private readonly routes = new Map<string, SessionRoute>();
  private nextId = 1;
  private stderr = "";
  private exited: Promise<void> = Promise.resolve();

  constructor(child: AcpChild) {
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    child.on("error", (error) => this.fail(new Error(`cannot start acp server: ${error.message}`)));
    // EPIPE on a dead child must not surface as an uncaught exception.
    child.stdin.on("error", (error) => this.fail(new Error(`acp stdin failed: ${error.message}`)));
    child.on("exit", (code) =>
      this.fail(new Error(`acp server exited (code ${code ?? "null"})${this.stderrSuffix()}`)),
    );
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    this.ready = this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      HANDSHAKE_TIMEOUT_MS,
    ).then(
      () => {
        if (this.state.status === "starting") this.state = { status: "ready" };
      },
      (error: Error) => {
        void this.close();
        throw error;
      },
    );
  }

  isClosed(): boolean {
    return this.state.status === "closed";
  }

  /** Route the child's messages for `sessionId` to `route` until the returned function is called. */
  attach(sessionId: string, route: SessionRoute): () => void {
    if (this.routes.has(sessionId)) throw new Error(`acp session ${sessionId} is already running a task`);
    this.routes.set(sessionId, route);
    return () => {
      if (this.routes.get(sessionId) === route) this.routes.delete(sessionId);
    };
  }

  isAttached(sessionId: string, route: SessionRoute): boolean {
    return this.routes.get(sessionId) === route;
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.state.status === "closed") return Promise.reject(this.state.error);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`acp ${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
      timer?.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.state.status !== "closed") this.write({ jsonrpc: "2.0", method, params });
  }

  /** Close the connection; resolves once the child process has exited. */
  close(): Promise<void> {
    this.fail(new Error("acp connection closed"));
    return this.exited;
  }

  private stderrSuffix(): string {
    const tail = this.stderr.trim();
    return tail ? `: ${tail}` : "";
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.state.status === "closed") return;
    this.state = { status: "closed", error };
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.routes.clear();
    this.exited = terminateChild(this.child);
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // tolerate non-protocol noise on stdout
    }
    if (!isRecord(message)) return;
    const { id, method, params } = message;
    if (typeof method === "string") {
      if (id === undefined) this.onNotification(method, params);
      else if (typeof id === "number" || typeof id === "string") this.onRequest(id, method, params);
    } else if (typeof id === "number") {
      this.onResponse(id, message);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update" || !isRecord(params) || typeof params.sessionId !== "string") return;
    this.routes.get(params.sessionId)?.update(params.update);
  }

  private onRequest(id: number | string, method: string, params: unknown): void {
    if (method !== "session/request_permission") {
      this.respondError(id, METHOD_NOT_FOUND, `unsupported client method ${method}`);
      return;
    }
    const route =
      isRecord(params) && typeof params.sessionId === "string" ? this.routes.get(params.sessionId) : undefined;
    if (route === undefined || !isRecord(params)) {
      this.respondError(id, INVALID_PARAMS, "no task is running on that session");
      return;
    }
    route.permission(params).then(
      (result) => this.respond(id, result),
      (error: unknown) => this.respondError(id, INTERNAL_ERROR, errorMessage(error)),
    );
  }

  private onResponse(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    if (isRecord(message.error)) {
      const { message: text, code } = message.error;
      pending.reject(
        new AcpRpcError(
          typeof text === "string" ? text : "acp request failed",
          typeof code === "number" ? code : INTERNAL_ERROR,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }
}
