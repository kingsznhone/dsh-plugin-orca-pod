/**
 * One `dsh --profile acp` child driven over ACP v1 with the official SDK. The
 * SDK owns JSON-RPC (ids, pending requests, newline-delimited framing, typed
 * params); this module owns the child process: spawning it, its lifetime, and
 * the routing of the child's per-session messages to the run that owns the
 * session. A failure of any kind closes the connection and terminates the child.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  ndJsonStream,
  type AgentRequestMethod,
  type AgentRequestParamsByMethod,
  type AgentRequestResponsesByMethod,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SendRequestOptions,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

import { isCmdShim, quoteForCmd, resolveCommand, terminateChild } from "../process.ts";

const STDERR_TAIL = 4096;
/** The handshake must not hang a task forever if the child is wedged. */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

type AcpChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** What one run does with the messages the child addresses to its session. */
export type SessionRoute = {
  update(update: SessionUpdate): void;
  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
};

type ConnectionState = { status: "starting" } | { status: "ready" } | { status: "closed"; error: Error };

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

/**
 * The child's stdout as the SDK's input. It does not end when stdout ends: the
 * SDK would then close with a bare "connection closed". It errors only once
 * the child is gone (`close`: exited and stdio drained), with `reason()`, so
 * pending requests learn the exit code and the stderr tail.
 */
function childOutput(child: AcpChild, reason: () => Error): ReadableStream<Uint8Array> {
  // The reader can cancel the stream first (the SDK does when the connection closes);
  // a chunk that arrives afterwards has no consumer and must not throw into the child's event loop.
  let open = true;
  return new ReadableStream({
    start(controller) {
      child.stdout.on("data", (chunk: Buffer) => {
        if (open) controller.enqueue(new Uint8Array(chunk));
      });
      child.on("close", () => {
        if (!open) return;
        open = false;
        controller.error(reason());
      });
    },
    cancel() {
      open = false;
    },
  });
}

function childInput(child: AcpChild): WritableStream<Uint8Array> {
  return new WritableStream({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        child.stdin.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
  });
}

/** Settle with `promise`, or reject after `timeoutMs`; the late result is dropped. */
function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`acp ${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class AcpConnection {
  /** Settles when `initialize` succeeded; rejects, with the connection closed, when it did not. */
  readonly ready: Promise<void>;
  private state: ConnectionState = { status: "starting" };
  private readonly child: AcpChild;
  private readonly rpc: ClientConnection;
  private readonly routes = new Map<string, SessionRoute>();
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
    const exitError = (): Error =>
      new Error(`acp server exited (code ${child.exitCode ?? "null"})${this.stderrSuffix()}`);
    child.on("close", () => this.fail(exitError()));

    this.rpc = client({ name: "orca-pod" })
      .onNotification("session/update", ({ params }) => {
        this.routes.get(params.sessionId)?.update(params.update);
      })
      .onRequest("session/request_permission", ({ params }) => {
        const route = this.routes.get(params.sessionId);
        if (route === undefined) throw RequestError.invalidParams(undefined, "no task is running on that session");
        return route.permission(params);
      })
      .connect(ndJsonStream(childInput(child), childOutput(child, exitError)));
    // The SDK closes on its own when the stream fails; the child goes with it.
    void this.rpc.closed.then(() => {
      const reason: unknown = this.rpc.signal.reason;
      this.fail(reason instanceof Error ? reason : new Error("acp connection closed"));
    });

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

  /** A typed agent request; rejects with the SDK's `RequestError` when the child answers with an error. */
  request<Method extends AgentRequestMethod>(
    method: Method,
    params: AgentRequestParamsByMethod[Method],
    timeoutMs?: number,
    options?: SendRequestOptions,
  ): Promise<AgentRequestResponsesByMethod[Method]> {
    if (this.state.status === "closed") return Promise.reject(this.state.error);
    return withTimeout(this.rpc.agent.request(method, params, options), method, timeoutMs);
  }

  /** Tell the child to stop the session's current prompt; it answers the prompt with `cancelled`. */
  cancel(sessionId: string): void {
    if (this.state.status !== "closed") this.rpc.agent.notify("session/cancel", { sessionId }).catch(() => {});
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

  private fail(error: Error): void {
    if (this.state.status === "closed") return;
    this.state = { status: "closed", error };
    this.routes.clear();
    this.rpc?.close(error);
    this.exited = terminateChild(this.child);
  }
}
