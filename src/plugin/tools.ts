/**
 * The single DSH tool registered by the Orca pod bundle.
 *
 * Every operation is a method on `orca_pod` instead of a separate tool, so the
 * agent's context carries one schema rather than five (send/status/cancel/
 * members/connect). Task methods are
 * non-blocking wrappers over `Orca`: `send` returns a task id immediately
 * and callers poll `status` for the result.
 */

import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { blobRefText, parseBlobRef, saveBlob } from "../core/blobs.ts";
import { normalizePeerUrl } from "../core/net.ts";
import { DEFAULT_PORT } from "../core/constants.ts";
import { isTerminal, type SubmitTaskInput, type TaskFile, type TaskState, type TaskView } from "../task/wire.ts";
import { parseModelSpec } from "../core/wire/model.ts";
import { narrowPermissionMode } from "../core/wire/permission.ts";
import type { PeerView } from "../core/wire/peer.ts";
import { runningInTask } from "../core/entry.ts";
import { abortError, errorMessage, PodError } from "../core/errors.ts";
import type { Orca } from "../node/orca.ts";

import { canonicalPath, writableRoots, type SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { ReasoningEffortId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { SANDBOX_MODES, type SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { snapshotJsonValue, type JsonValue } from "@deepseek-ai/dsh-util-values";
import {
  defineTool,
  type InferArgs,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolExecution,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type { Pod } from "./pod.ts";
import type { OptionalService } from "./services.ts";
import type { Tracker } from "./tracker.ts";

const ASYNC_NOTE =
  'Tasks run asynchronously on the remote orca node: method "send" returns as soon as the remote accepts the task, and method "status" observes the returned task_id.';

const METHODS_HELP =
  "Methods: " +
  "send (peer, text; optional files, echo, permission_mode, model, reasoning_effort) dispatches a task to a node; " +
  "fetch (ref, output) saves a file a task handed back, named <orca node id>/<sha256> in its artifacts; " +
  "status (peer, task_id) reads one task; " +
  "cancel (peer, task_id) requests cancellation; " +
  "members (no arguments) lists this node and its peers; " +
  `connect (peer; bare host or host:port defaults to ${DEFAULT_PORT}) joins a peer into the mesh.`;

// ---- what a call carries ----

const METHOD_NAMES = ["send", "fetch", "status", "cancel", "members", "connect"] as const;

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
  files: {
    type: "array",
    items: { type: "string" },
    description:
      "send: files the task needs, each a local path or a file a member published as <orca node id>/<sha256>. " +
      "They are placed in the task's inbox/ directory before it starts; whatever the task leaves in its outbox/ comes back as artifacts.",
  },
  ref: { type: "string", description: "fetch: the file to save, as <orca node id>/<sha256>." },
  output: { type: "string", description: "fetch: where to save it; the session's sandbox must allow writing there." },
  task_id: { type: "string", description: 'status/cancel: task id returned by method "send".' },
  echo: {
    type: "object",
    additionalProperties: true,
    description:
      "send: optional deterministic echo script forwarded as metadata.echo for tests: " +
      "{steps:[{at_ms,suspend:{kind,reason|tool,...}}],final:{state,text},artifacts:[{name,content}]}.",
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

type ToolArgs = InferArgs<typeof PARAMETERS>;
type TextKey = "peer" | "text" | "task_id" | "reasoning_effort" | "ref" | "output";

type PeerArgs = { peer: string };
type TaskArgs = PeerArgs & { task_id: string };
type FetchArgs = { ref: string; output: string };
type SendArgs = PeerArgs & {
  text: string;
  files: string[];
  echo: ToolArgs["echo"];
  permission_mode: SandboxMode | undefined;
  model: string | undefined;
  reasoning_effort: ReasoningEffortId | undefined;
};

/** One call of the tool: its method and the arguments that method takes. */
type PodCall =
  | { method: "send"; args: SendArgs }
  | { method: "fetch"; args: FetchArgs }
  | { method: "status" | "cancel"; args: TaskArgs }
  | { method: "connect"; args: PeerArgs }
  | { method: "members" };

// ---- what a call answers ----

/** A node as `members` and `connect` list it. */
type PeerSummary = Pick<
  PeerView,
  "orca_node_id" | "display_name" | "endpoints" | "state" | "busy" | "runtime" | "last_recv_at" | "max_task_ttl_s"
>;

type SendResult = { task_id: string; state: TaskState; peer: string; node: string };
type FetchResult = { path: string; size: number };
type TaskStatusResult = TaskView & { terminal: boolean };
type ConnectResult = { peer: string; members: PeerSummary[]; members_digest: string };
type MembersResult = { self: PeerSummary } & Omit<ConnectResult, "peer">;

/** The single `orca_pod` tool, bound to one pod. */
export class PodTool {
  constructor(
    private readonly pod: Pod,
    private readonly tracker: Tracker,
    private readonly sandbox?: OptionalService<"sandboxPolicy">,
  ) {}

  definition(): ToolDefinition {
    return defineTool({
      name: "orca_pod",
      description:
        "Operate the Orca Pod mesh from this session: dispatch and inspect tasks on other orca nodes, list members, or join a new peer. " +
        METHODS_HELP +
        " " +
        ASYNC_NOTE,
      parameters: PARAMETERS,
      // Output differs per method (task views, a roster): unconstrained JSON.
      output: { schema: { type: "json", description: "JSON payload rendered as text." }, render: PodTool.renderJson },
      execute: async (args, exec) => {
        const call = PodTool.parseCall(args);
        try {
          PodTool.throwIfAborted(exec.signal);
          // The call's own work observes the signal and settles when it stops (B20).
          return PodTool.json(await this.run(call, exec));
        } catch (error) {
          throw PodTool.describeError("orca_pod", error);
        }
      },
    });
  }

  /** Dispatch a task and track it for the dispatching agent. */
  private async send(args: SendArgs, exec: ToolRunContext): Promise<SendResult> {
    // Tasks are single-hop: a session the task executor spawned never dispatches (§7.9).
    if (runningInTask()) {
      throw new Error(
        "send is not available inside a task: tasks are single-hop; end the task with a BLOCKED: report instead",
      );
    }
    const { signal } = exec;
    const permissionMode = PodTool.taskMode(
      args.permission_mode,
      PodTool.sessionSandboxMode(this.sandbox?.current(), exec),
    );
    const model =
      args.model === undefined ? undefined : (parseModelSpec(args.model, args.reasoning_effort) ?? undefined);
    if (args.model !== undefined && model === undefined) {
      throw new Error("model must be a provider/model string");
    }
    const orca = await this.awaitOrca(signal);
    const node = orca.mesh.resolve(args.peer);
    const files = await this.attach(orca, args.files, exec);
    const input: SubmitTaskInput = {
      message: { role: "user", parts: [{ kind: "text", text: args.text }] },
      metadata: {
        echo: args.echo,
        pod: {
          ...(files.length === 0 ? {} : { files }),
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
    // Track the task so the dispatching agent is told when it finishes, even
    // after its turn ends.
    if (exec.agent !== undefined) this.tracker.track(exec.agent, node.id, view.id);
    return { task_id: view.id, state: view.status.state, peer: node.displayName, node: node.id };
  }

  /**
   * The files a task is handed (§3.8): a published file is named as it is, a
   * local path is published by this node first, so the target can fetch it from
   * here before the agent starts.
   */
  private async attach(orca: Orca, items: string[], exec: ToolRunContext): Promise<TaskFile[]> {
    const files: TaskFile[] = [];
    for (const item of items) {
      const ref = parseBlobRef(item);
      if (ref !== null) {
        files.push({ ref: blobRefText(ref), name: ref.blob });
        continue;
      }
      PodTool.throwIfAborted(exec.signal);
      const path = resolve(this.workingDirectory(exec), item);
      const blob = await orca.publish(path).catch((error: unknown) => {
        throw new Error(`cannot hand over ${item}: ${errorMessage(error)}`);
      });
      files.push({ ref: blobRefText({ node: orca.orcaNodeId, blob: blob.blob_id }), name: basename(path) });
    }
    return files;
  }

  /** Save a file a task handed back, where the session sandbox lets it write (§3.8). */
  private async fetch(args: FetchArgs, exec: ToolRunContext): Promise<FetchResult> {
    const ref = parseBlobRef(args.ref);
    if (ref === null) throw new Error("ref must be <orca node id>/<sha256>, as a task artifacts name it");
    const output = resolve(this.workingDirectory(exec), args.output);
    this.assertWritable(output, exec);
    const orca = await this.awaitOrca(exec.signal);
    const opened = await orca.mesh.require(ref.node).fetchBlob(ref.blob, exec.signal);
    await mkdir(dirname(output), { recursive: true });
    const { size } = await saveBlob(opened, output, ref.blob);
    return { path: output, size };
  }

  /** The session own directory, which relative paths are read against; the process one when there is none. */
  private workingDirectory(exec: ToolExecution): string {
    const session = exec.agent?.session;
    const policy = this.sandbox?.current();
    return policy === undefined || session === undefined ? process.cwd() : policy.resolve({ session }).workspaceRoot;
  }

  /** The session sandbox decides where this tool may write; without one to ask, it does not write. */
  private assertWritable(path: string, exec: ToolExecution): void {
    const session = exec.agent?.session;
    const policy = this.sandbox?.current();
    if (policy === undefined || session === undefined) {
      throw new Error(
        "the session sandbox policy is not available, so it cannot be checked that this path may be written",
      );
    }
    const resolved = policy.resolve({ session });
    if (resolved.mode === "danger-full-access") return;
    const target = canonicalPath(dirname(path));
    const allowed = writableRoots(resolved).some((root) => {
      const inside = relative(root, target);
      return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
    });
    if (!allowed) throw new Error(`the session sandbox (${resolved.mode}) does not allow writing to ${path}`);
  }

  private async status(args: TaskArgs, signal: AbortSignal): Promise<TaskStatusResult> {
    const orca = await this.awaitOrca(signal);
    return PodTool.taskStatus(await orca.mesh.resolve(args.peer).getTask(args.task_id, signal));
  }

  private async cancel(args: TaskArgs, signal: AbortSignal): Promise<TaskStatusResult> {
    const orca = await this.awaitOrca(signal);
    return PodTool.taskStatus(await orca.mesh.resolve(args.peer).cancelTask(args.task_id, signal));
  }

  private async members(signal: AbortSignal): Promise<MembersResult> {
    const { mesh } = await this.awaitOrca(signal);
    return {
      self: PodTool.peerSummary(mesh.self.selfRecord()),
      members: mesh.peers().map((node) => PodTool.peerSummary(node.view())),
      members_digest: mesh.digest(),
    };
  }

  private async connect(args: PeerArgs, signal: AbortSignal): Promise<ConnectResult> {
    const peer = normalizePeerUrl(args.peer);
    await this.awaitOrca(signal);
    // Connecting persists the peer; do not start it for a turn that is already gone.
    PodTool.throwIfAborted(signal);
    await this.pod.addPeer(peer);
    const { mesh } = await this.awaitOrca(signal);
    return {
      peer,
      members: mesh.peers().map((node) => PodTool.peerSummary(node.view())),
      members_digest: mesh.digest(),
    };
  }

  /** Dispatch one `orca_pod` call against the running node. */
  private run(
    call: PodCall,
    exec: ToolRunContext,
  ): Promise<SendResult | FetchResult | TaskStatusResult | MembersResult | ConnectResult> {
    switch (call.method) {
      case "send":
        return this.send(call.args, exec);
      case "fetch":
        return this.fetch(call.args, exec);
      case "status":
        return this.status(call.args, exec.signal);
      case "cancel":
        return this.cancel(call.args, exec.signal);
      case "members":
        return this.members(exec.signal);
      case "connect":
        return this.connect(call.args, exec.signal);
    }
  }

  /**
   * Wait for any (re)start in progress, then fail the tool call when the orca
   * node is not usable. A restart is the host's work, not this call's, so a
   * cancelled turn may stop waiting for it right away.
   */
  private async awaitOrca(signal: AbortSignal): Promise<Orca> {
    await PodTool.waitUnlessAborted(this.pod.settled(), signal);
    return this.pod.requireRun().orca;
  }

  private static renderJson(_args: unknown, value: unknown): ContentBlock[] {
    return [{ type: "text", text: JSON.stringify(value, null, 2) }];
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
            files: (args.files ?? []).map((item) => {
              const path = item.trim();
              if (path.length === 0) throw new Error("files must not contain a blank entry");
              return path;
            }),
            echo: args.echo,
            permission_mode: args.permission_mode,
            model: args.model,
            reasoning_effort: effort === undefined ? undefined : ReasoningEffortId(effort),
          },
        };
      }
      case "fetch":
        return { method, args: { ref: PodTool.need(args, "ref"), output: PodTool.need(args, "output") } };
      case "status":
      case "cancel":
        return { method, args: { peer: PodTool.need(args, "peer"), task_id: PodTool.need(args, "task_id") } };
      case "connect":
        return { method, args: { peer: PodTool.need(args, "peer") } };
      case "members":
        return { method };
    }
  }

  private static peerSummary(peer: PeerView): PeerSummary {
    return {
      orca_node_id: peer.orca_node_id,
      display_name: peer.display_name,
      endpoints: peer.endpoints,
      state: peer.state,
      busy: peer.busy,
      runtime: peer.runtime,
      last_recv_at: peer.last_recv_at,
      max_task_ttl_s: peer.max_task_ttl_s,
    };
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

  /**
   * Wrap an error with the operation that failed, keeping the pod error code (and
   * its status) when the failure came from a pod call.
   */
  private static describeError(operation: string, error: unknown): Error {
    if (error instanceof PodError) {
      return new PodError(error.code, `${operation} [${error.code}]: ${error.message}`, error.status);
    }
    return new Error(`${operation}: ${errorMessage(error)}`);
  }

  /** A result as the lossless JSON DSH stores; every method answers with data read from JSON. */
  private static json(value: unknown): JsonValue {
    const snapshot = snapshotJsonValue(value);
    if (snapshot === undefined) throw new Error("the result is not lossless JSON");
    return snapshot as JsonValue;
  }

  /**
   * The dispatching session's sandbox mode (`ctx.sandboxPolicy` resolves it, and
   * its `SandboxMode` values match the orca node permission modes, so a task
   * inherits the session setting verbatim). Undefined without the service or a
   * session; the task then starts read-only.
   */
  private static sessionSandboxMode(
    policy: SandboxPolicyService | undefined,
    exec: ToolExecution,
  ): SandboxMode | undefined {
    const session = exec.agent?.session;
    if (policy === undefined || session === undefined) return undefined;
    return policy.resolve({ session }).mode;
  }

  private static taskStatus(view: TaskView): TaskStatusResult {
    return { ...view, terminal: isTerminal(view.status.state) };
  }
}
