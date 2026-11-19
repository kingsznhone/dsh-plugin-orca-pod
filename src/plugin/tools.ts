/**
 * The single DSH tool registered by the Orca pod bundle.
 *
 * Every operation is a method on `orca_pod` instead of a separate tool, so the
 * agent's context carries one schema. In the host it drives the node of this
 * process: task methods are non-blocking (`send` returns a task id at once,
 * `status` reads it), and the file methods publish and fetch (§5.6). Inside a
 * task (another `dsh` process, no node of its own) it has the file methods
 * only, which go through this machine's node (`LocalNode`).
 */

import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { blobRefText, parseBlobRef, saveBlob } from "../core/blobs.ts";
import { normalizePeerUrl } from "../core/net.ts";
import { DEFAULT_PORT } from "../core/constants.ts";
import { isTerminal, type SubmitTaskInput, type TaskState } from "../task/wire.ts";
import { parseModelSpec } from "../core/wire/model.ts";
import { narrowPermissionMode } from "../core/wire/permission.ts";
import type { PeerView } from "../core/wire/peer.ts";
import { abortError, errorMessage, PodError } from "../core/errors.ts";
import type { Orca } from "../node/orca.ts";

import { canonicalPath, writableRoots, type SandboxExecutionPolicy, type SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { ReasoningEffortId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { SANDBOX_MODES } from "@deepseek-ai/dsh-sandbox-policy";
import { snapshotJsonValue, type JsonValue } from "@deepseek-ai/dsh-util-values";
import {
  defineTool,
  type InferArgs,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolExecution,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type { LocalNode, PublishedFile } from "./local-node.ts";
import type { Pod } from "./pod.ts";
import type { OptionalService } from "./services.ts";

const ASYNC_NOTE =
  'Tasks run asynchronously on the remote orca node: method "send" returns as soon as the remote accepts the task, and method "status" observes the returned task_id.';

const FILES_HELP =
  "Files are named <orca node id>/<sha256> and are not part of a task: put the names of the files a task needs in its text, and read the names of the files it hands back in its result. " +
  "publish (path; optional ttl_s, 0 = never expires, default 7 days) copies a local file into this machine's node and returns its name; " +
  "fetch (ref, output) saves a file any member published. ";

const METHODS_HELP =
  "Methods: " +
  "send (peer, text; optional echo, permission_mode, model, reasoning_effort) dispatches a task to a node; " +
  FILES_HELP +
  "status (peer, task_id) reads one task; " +
  "cancel (peer, task_id) requests cancellation; " +
  "members (no arguments) lists this node and its peers; " +
  `connect (peer; bare host or host:port defaults to ${DEFAULT_PORT}) joins a peer into the mesh.`;

// ---- what a call carries ----

const METHOD_NAMES = ["send", "fetch", "publish", "status", "cancel", "members", "connect"] as const;

/** What a task session may do: move files through this machine's node (§5.6). */
const TASK_METHOD_NAMES = ["fetch", "publish"] as const;

/**
 * Every argument of every method, declared once in DSH's tool schema DSL: DSH
 * compiles it to the JSON Schema the model sees and checks types and enums
 * before `execute` runs. Which method needs which argument is checked below.
 */
const PARAMETERS = {
  method: {
    type: "string",
    enum: METHOD_NAMES,
    required: true,
    description: "Operation to perform. See the tool description for each method's arguments.",
  },
  peer: {
    type: "string",
    description:
      "Target node: its id, its display name (when that is unique) or an address it has. Required by send, status and cancel. " +
      `For connect it is the address of a node to join: http://host:port, host:port, or a bare host (port defaults to ${DEFAULT_PORT}).`,
  },
  text: { type: "string", description: "send: task text sent as an A2A user message part." },
  ref: { type: "string", description: "fetch: the file to save, as <orca node id>/<sha256>." },
  output: { type: "string", description: "fetch: where to save it; the session's sandbox must allow writing there." },
  path: { type: "string", description: "publish: the local file to publish." },
  ttl_s: {
    type: "integer",
    description: "publish: optional seconds the file stays downloadable; 0 never expires. Default 7 days.",
  },
  task_id: { type: "string", description: 'status/cancel: task id returned by method "send".' },
  echo: {
    type: "object",
    additionalProperties: true,
    description:
      "send: optional deterministic echo script forwarded as metadata.echo for tests: " +
      "{steps:[{at_ms,suspend:{kind,reason|tool,...}}],final:{state,text}}.",
  },
  permission_mode: {
    type: "string",
    enum: SANDBOX_MODES,
    description:
      "send: optional permission mode, no wider than this session's (the default). The target caps it by its own policy; when the task needs more it asks the user here to upgrade it.",
  },
  model: {
    type: "string",
    description:
      "send: optional model for the target task as provider/model. The target must advertise it and run the ACP executor.",
  },
  reasoning_effort: {
    type: "string",
    description: "send: optional reasoning effort for the selected model; only meaningful together with model.",
  },
} as const satisfies ParameterSchemaSpec;

/** The same arguments, cut down to the methods a task session has. */
const TASK_PARAMETERS = {
  method: { ...PARAMETERS.method, enum: TASK_METHOD_NAMES },
  ref: PARAMETERS.ref,
  output: PARAMETERS.output,
  path: PARAMETERS.path,
  ttl_s: PARAMETERS.ttl_s,
} as const satisfies ParameterSchemaSpec;

type ToolArgs = InferArgs<typeof PARAMETERS>;
type TextKey = "peer" | "text" | "task_id" | "reasoning_effort" | "ref" | "output" | "path";

type PeerArgs = { peer: string };
type TaskArgs = PeerArgs & { task_id: string };
type FetchArgs = { ref: string; output: string };
type PublishArgs = { path: string; ttl_s: number | undefined };
type SendArgs = PeerArgs & {
  text: string;
  echo: ToolArgs["echo"];
  permission_mode: SandboxMode | undefined;
  model: string | undefined;
  reasoning_effort: ReasoningEffortId | undefined;
};

/** One call of the tool: its method and the arguments that method takes. */
type PodCall =
  | { method: "send"; args: SendArgs }
  | { method: "fetch"; args: FetchArgs }
  | { method: "publish"; args: PublishArgs }
  | { method: "status" | "cancel"; args: TaskArgs }
  | { method: "connect"; args: PeerArgs }
  | { method: "members" };

// ---- what a call answers ----

type SendResult = { task_id: string; state: TaskState; peer: string; node: string };
type FetchResult = { path: string; size: number };
type ConnectResult = { peer: string; members: PeerView[]; members_digest: string };

/**
 * The machine's node as the tool reaches it: the pod of this process (the host),
 * or, inside a task, the node's local routes.
 */
type ToolNode = { kind: "host"; pod: Pod } | { kind: "task"; local: LocalNode };

/** The calls a task session can make: files only. */
type FileCall = Extract<PodCall, { method: "fetch" | "publish" }>;

/** The single `orca_pod` tool, bound to this machine's node. */
export class PodTool {
  constructor(
    private readonly node: ToolNode,
    private readonly sandbox: OptionalService<"sandboxPolicy">,
  ) {}

  definition(): ToolDefinition {
    // Output differs per method (task views, a roster): unconstrained JSON.
    const output = {
      schema: { type: "json", description: "JSON payload rendered as text." },
      render: (_args: unknown, value: unknown): ContentBlock[] => [
        { type: "text", text: JSON.stringify(value, null, 2) },
      ],
    } as const;
    const { node } = this;
    if (node.kind === "task") {
      return defineTool({
        name: "orca_pod",
        description: `Move files between this task and the Orca Pod mesh, through this machine's orca node. ${FILES_HELP}`,
        parameters: TASK_PARAMETERS,
        output,
        execute: (args, exec) => this.execute(exec, () => this.runFile(PodTool.parseFileCall(args), exec)),
      });
    }
    return defineTool({
      name: "orca_pod",
      description:
        "Operate the Orca Pod mesh from this session: dispatch and inspect tasks on other orca nodes, move files, list members, or join a new peer. " +
        METHODS_HELP +
        " " +
        ASYNC_NOTE,
      parameters: PARAMETERS,
      output,
      execute: (args, exec) => this.execute(exec, () => this.run(node.pod, PodTool.parseCall(args), exec)),
    });
  }

  /** Run one call as lossless JSON; an error names the tool, and keeps the pod error code and status it came with. */
  private async execute(exec: ToolRunContext, call: () => Promise<unknown>): Promise<JsonValue> {
    try {
      PodTool.throwIfAborted(exec.signal);
      // The call's own work observes the signal and settles when it stops (B20).
      const snapshot = snapshotJsonValue(await call());
      if (snapshot === undefined) throw new Error("the result is not lossless JSON");
      return snapshot as JsonValue;
    } catch (error) {
      if (error instanceof PodError) {
        throw new PodError(error.code, `orca_pod [${error.code}]: ${error.message}`, error.status);
      }
      throw new Error(`orca_pod: ${errorMessage(error)}`);
    }
  }

  /** Dispatch a task; the dispatch log records it for the tracker. */
  private async send(pod: Pod, args: SendArgs, exec: ToolRunContext): Promise<SendResult> {
    const { signal } = exec;
    const permissionMode = PodTool.taskMode(args.permission_mode, this.sessionPolicy(exec)?.mode);
    const model =
      args.model === undefined ? undefined : (parseModelSpec(args.model, args.reasoning_effort) ?? undefined);
    if (args.model !== undefined && model === undefined) {
      throw new Error("model must be a provider/model string");
    }
    const orca = await PodTool.awaitOrca(pod, signal);
    const node = orca.mesh.resolve(args.peer);
    const input: SubmitTaskInput = {
      message: { role: "user", parts: [{ kind: "text", text: args.text }] },
      metadata: {
        echo: args.echo,
        pod: {
          permission_mode: permissionMode,
          model,
          reasoning_effort: model === undefined ? args.reasoning_effort : undefined,
        },
      },
    };
    PodTool.throwIfAborted(signal);
    const view = await node.sendTask(input, { signal, agentId: exec.agent?.id });
    if (signal.aborted) {
      // The remote accepted the task after the caller's turn was cancelled: the
      // caller never learns its id, so it must not keep running unobserved.
      // Best effort; the dispatch log still lists it for the panel.
      node.cancelTask(view.id).catch(() => {});
      throw abortError("cancelled by the caller");
    }
    // The dispatch log now holds the task; the tracker follows it from there and
    // tells the dispatching session when it ends.
    return { task_id: view.id, state: view.status.state, peer: node.displayName, node: node.id };
  }

  /** Save a file a member published, where the session sandbox lets it write (§5.6). */
  private async fetch(args: FetchArgs, exec: ToolRunContext): Promise<FetchResult> {
    const ref = parseBlobRef(args.ref);
    if (ref === null) throw new Error("ref must be <orca node id>/<sha256>");
    const policy = this.sessionPolicy(exec);
    const output = resolve(policy?.workspaceRoot ?? process.cwd(), args.output);
    // The session sandbox decides where this tool may write; without one to ask, it does not write.
    if (policy === undefined) {
      throw new Error(
        "the session sandbox policy is not available, so it cannot be checked that this path may be written",
      );
    }
    if (policy.mode !== "danger-full-access") {
      const target = canonicalPath(dirname(output));
      const allowed = writableRoots(policy).some((root) => {
        const inside = relative(root, target);
        return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
      });
      if (!allowed) throw new Error(`the session sandbox (${policy.mode}) does not allow writing to ${output}`);
    }
    const { node } = this;
    const opened =
      node.kind === "task"
        ? await node.local.open(ref, exec.signal)
        : await (await PodTool.awaitOrca(node.pod, exec.signal)).mesh
            .require(ref.node)
            .fetchBlob(ref.blob, exec.signal);
    await mkdir(dirname(output), { recursive: true });
    const { size } = await saveBlob(opened, output, ref.blob);
    return { path: output, size };
  }

  /** Copy a local file into this machine's node and name it (§5.6); the copy lives for its TTL. */
  private async publish(args: PublishArgs, exec: ToolRunContext): Promise<PublishedFile> {
    const path = resolve(this.sessionPolicy(exec)?.workspaceRoot ?? process.cwd(), args.path);
    const { node } = this;
    if (node.kind === "task") return node.local.publish(path, args.ttl_s, exec.signal);
    const orca = await PodTool.awaitOrca(node.pod, exec.signal);
    // Publishing copies the file: do not start it for a turn that is already gone.
    PodTool.throwIfAborted(exec.signal);
    const blob = await orca.blobs.register(path, args.ttl_s);
    return {
      ref: blobRefText({ node: orca.orcaNodeId, blob: blob.blob_id }),
      size: blob.size,
      expires_at: blob.expires_at,
    };
  }

  /**
   * The calling session's sandbox, as the host resolves it (`ctx.sandboxPolicy`):
   * its mode, which a dispatched task inherits verbatim, and its workspace root,
   * which relative paths are read against. Undefined without the service or a session.
   */
  private sessionPolicy(exec: ToolExecution): SandboxExecutionPolicy | undefined {
    const session = exec.agent?.session;
    const policy = this.sandbox.current();
    return policy === undefined || session === undefined ? undefined : policy.resolve({ session });
  }

  private async connect(pod: Pod, args: PeerArgs, signal: AbortSignal): Promise<ConnectResult> {
    const peer = normalizePeerUrl(args.peer);
    await PodTool.awaitOrca(pod, signal);
    // Connecting persists the peer; do not start it for a turn that is already gone.
    PodTool.throwIfAborted(signal);
    await pod.addPeer(peer);
    const { mesh } = await PodTool.awaitOrca(pod, signal);
    return {
      peer,
      members: mesh.peers().map((node) => node.view()),
      members_digest: mesh.digest(),
    };
  }

  /** Dispatch one call of the host's tool against the running node. */
  private async run(pod: Pod, call: PodCall, exec: ToolRunContext): Promise<unknown> {
    const { signal } = exec;
    switch (call.method) {
      case "send":
        return this.send(pod, call.args, exec);
      case "fetch":
      case "publish":
        return this.runFile(call, exec);
      case "status": {
        const view = await (await PodTool.awaitOrca(pod, signal)).mesh
          .resolve(call.args.peer)
          .getTask(call.args.task_id, signal);
        return { ...view, terminal: isTerminal(view.status.state) };
      }
      case "cancel": {
        const view = await (await PodTool.awaitOrca(pod, signal)).mesh
          .resolve(call.args.peer)
          .cancelTask(call.args.task_id, signal);
        return { ...view, terminal: isTerminal(view.status.state) };
      }
      case "members": {
        const { mesh } = await PodTool.awaitOrca(pod, signal);
        return {
          self: mesh.self.selfRecord(),
          members: mesh.peers().map((node) => node.view()),
          members_digest: mesh.digest(),
        };
      }
      case "connect":
        return this.connect(pod, call.args, signal);
    }
  }

  private runFile(call: FileCall, exec: ToolRunContext): Promise<FetchResult | PublishedFile> {
    return call.method === "fetch" ? this.fetch(call.args, exec) : this.publish(call.args, exec);
  }

  /**
   * Wait for any (re)start in progress, then fail the tool call when the orca
   * node is not usable. A restart is the host's work, not this call's, so a
   * cancelled turn may stop waiting for it right away.
   */
  private static awaitOrca(pod: Pod, signal: AbortSignal): Promise<Orca> {
    return PodTool.waitUnlessAborted(pod.orca(), signal);
  }

  /** A text argument with its whitespace trimmed; blank counts as absent. */
  private static optional(args: ToolArgs, key: TextKey): string | undefined {
    const value = args[key]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  }

  /** A text argument the method needs. */
  private static need(args: ToolArgs, key: TextKey): string {
    const value = PodTool.optional(args, key);
    if (value === undefined) throw new Error(`${key} must be a non-empty string`);
    return value;
  }

  private static parseCall(args: ToolArgs): PodCall {
    const { method } = args;
    switch (method) {
      case "send": {
        if (args.reasoning_effort !== undefined && PodTool.optional(args, "reasoning_effort") === undefined) {
          throw new Error("reasoning_effort must not be blank");
        }
        const effort = PodTool.optional(args, "reasoning_effort");
        return {
          method,
          args: {
            peer: PodTool.need(args, "peer"),
            text: PodTool.need(args, "text"),
            echo: args.echo,
            permission_mode: args.permission_mode,
            model: args.model,
            reasoning_effort: effort === undefined ? undefined : ReasoningEffortId(effort),
          },
        };
      }
      case "fetch":
      case "publish":
        return PodTool.parseFileCall({ ...args, method });
      case "status":
      case "cancel":
        return { method, args: { peer: PodTool.need(args, "peer"), task_id: PodTool.need(args, "task_id") } };
      case "connect":
        return { method, args: { peer: PodTool.need(args, "peer") } };
      case "members":
        return { method };
    }
  }

  private static parseFileCall(args: ToolArgs & { method: FileCall["method"] }): FileCall {
    if (args.method === "fetch") {
      return { method: "fetch", args: { ref: PodTool.need(args, "ref"), output: PodTool.need(args, "output") } };
    }
    if (args.ttl_s !== undefined && (!Number.isInteger(args.ttl_s) || args.ttl_s < 0)) {
      throw new Error("ttl_s must be a non-negative integer");
    }
    return { method: "publish", args: { path: PodTool.need(args, "path"), ttl_s: args.ttl_s } };
  }

  /**
   * The mode a dispatched task starts with: the session's, or a narrower one the
   * caller names (P1). A wider one is refused: the target asks the origin for an
   * upgrade when the task needs it (§7.12). A session whose mode cannot be read
   * counts as read-only.
   */
  private static taskMode(explicit: SandboxMode | undefined, session: SandboxMode | undefined): SandboxMode {
    const ceiling = session ?? "read-only";
    if (explicit === undefined) return ceiling;
    if (narrowPermissionMode(ceiling, explicit) !== explicit) {
      throw new Error(
        `permission_mode ${explicit} is wider than this session's ${ceiling}; a task can only start narrower, and asks for an upgrade when it needs one`,
      );
    }
    return explicit;
  }

  private static throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortError("cancelled by the caller");
  }

  /**
   * Wait for something this call does not own (startup), or stop waiting when
   * the caller's turn is cancelled. Never wrap the call's own work in this: a
   * tool settles only after its work has stopped (dsh-tools `execute`), so the
   * methods forward the signal to their requests and finish on their own.
   */
  private static waitUnlessAborted<T>(wait: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError("cancelled by the caller"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortError("cancelled by the caller"));
      signal.addEventListener("abort", onAbort, { once: true });
      wait.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}
