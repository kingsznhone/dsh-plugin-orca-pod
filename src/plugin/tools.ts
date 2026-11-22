/**
 * The single DSH tool registered by the Orca pod bundle.
 *
 * Every operation is a method on `orca_pod` instead of a separate tool, so the
 * agent's context carries one schema. In the host it drives the node of this
 * process: task methods are non-blocking (`send` returns a task id at once,
 * `status` reads it), and the file methods publish and fetch (design.md 4.5). Inside a
 * task (another `dsh` process, no node of its own) it has the file methods
 * only, which go through this machine's node (`LocalNode`).
 */

import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { z } from "zod";

import { LOCAL_TOKEN_HEADER } from "../api/access.ts";
import {
  isPathWithinRoot,
  parseBlobRef,
  PublishedFileSchema,
  saveBlob,
  type BlobRef,
  type OpenedBlob,
  type PublishedFile,
} from "../core/blobs.ts";
import { DEFAULT_PORT } from "../core/constants.ts";
import type { OrcaNodeId } from "../core/ids.ts";
import { DEFAULT_RECENT_LIMIT } from "../task/json-table.ts";
import { isTerminal, type SubmitTaskInput, type TaskState } from "../task/wire.ts";
import { parseModelSpec, ReasoningEffortSchema } from "../executor/model.ts";
import { narrowPermissionMode, SandboxModeSchema } from "../executor/permission.ts";
import { parseOrThrow } from "../core/schema.ts";
import type { PeerView } from "../mesh/wire.ts";
import { abortError, errorMessage, PodError } from "../core/errors.ts";
import { NODE_ID_ENV, NODE_TOKEN_ENV, NODE_URL_ENV, type Orca } from "../node/orca.ts";
import { nodeFetch } from "../mesh/peer-client.ts";
import { PeerTls } from "../mesh/tls.ts";

import { canonicalPath, writableRoots, type SandboxExecutionPolicy, type SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { SANDBOX_MODES } from "@deepseek-ai/dsh-sandbox-policy";
import { snapshotJsonValue, type JsonValue } from "@deepseek-ai/dsh-util-values";
import {
  defineTool,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolExecution,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
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
  "send (peer, text; optional permission_mode, model, reasoning_effort) dispatches a task to a node; " +
  FILES_HELP +
  "status (peer, task_id) reads one task; " +
  "cancel (peer, task_id) requests cancellation; " +
  "tasks (optional limit default 10 max 100, before, offset, state, peer, scope) queries recent or historical local/dispatched tasks; " +
  "members (no arguments) lists this node and its peers; " +
  `connect (peer; bare host or host:port defaults to ${DEFAULT_PORT}) joins a peer into the mesh.`;

// ---- what a call carries ----

const METHOD_NAMES = ["send", "fetch", "publish", "status", "cancel", "tasks", "members", "connect"] as const;

const TASK_QUERY_STATES = [
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
  "unknown",
] as const;

const TASK_QUERY_SCOPES = ["all", "local", "dispatched"] as const;
const MAX_TASK_QUERY_LIMIT = 100;

/** What a task session may do: move files through this machine's node (design.md 4.5). */
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
      "Target node: its id, its display name (when that is unique) or an address it has. Required by send, status and cancel; optional filter for tasks. " +
      `For connect it is the address of a node to join: https://host:port, host:port, or a bare host (port defaults to ${DEFAULT_PORT}).`,
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
  limit: {
    type: "integer",
    description: `tasks: maximum records to return (1-${MAX_TASK_QUERY_LIMIT}, default ${DEFAULT_RECENT_LIMIT}).`,
  },
  offset: {
    type: "integer",
    description: "tasks: number of matching records to skip (default 0). Prefer before for stable pagination.",
  },
  before: {
    type: "string",
    description: "tasks: ISO-8601 timestamp cursor; return only records updated strictly before this time.",
  },
  state: {
    type: "string",
    enum: TASK_QUERY_STATES,
    description: "tasks: optional task state filter.",
  },
  scope: {
    type: "string",
    enum: TASK_QUERY_SCOPES,
    description:
      'tasks: which records to search: "local" (ran on this node), "dispatched" (sent to peers), or "all" (default).',
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
    description:
      "send: optional reasoning effort for the task's model (the selected model, or the target's default model).",
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

/**
 * What each method needs, checked after DSH has checked the types and enums
 * against `PARAMETERS`: the model may still leave out an argument its method
 * needs, or send one that is blank. Text arguments are trimmed.
 */
const Text = z.string("must be a non-empty string").trim().min(1, "must be a non-empty string");

const FetchCall = z.object({ method: z.literal("fetch"), ref: Text, output: Text });
const PublishCall = z.object({
  method: z.literal("publish"),
  path: Text,
  ttl_s: z.int("must be a non-negative integer").min(0, "must be a non-negative integer").optional(),
});
const SendCall = z.object({
  method: z.literal("send"),
  peer: Text,
  text: Text,
  permission_mode: SandboxModeSchema.optional(),
  model: z.string().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
});
const TasksCall = z.object({
  method: z.literal("tasks"),
  limit: z
    .int(`must be an integer between 1 and ${MAX_TASK_QUERY_LIMIT}`)
    .min(1, `must be an integer between 1 and ${MAX_TASK_QUERY_LIMIT}`)
    .max(MAX_TASK_QUERY_LIMIT, `must be an integer between 1 and ${MAX_TASK_QUERY_LIMIT}`)
    .optional(),
  offset: z.int("must be a non-negative integer").min(0, "must be a non-negative integer").optional(),
  before: Text.optional(),
  state: z.enum(TASK_QUERY_STATES).optional(),
  peer: Text.optional(),
  scope: z.enum(TASK_QUERY_SCOPES).optional(),
});

/** The calls a task session can make: files only. */
const FileCallSchema = z.discriminatedUnion("method", [FetchCall, PublishCall]);

/** One call of the host's tool: its method and the arguments that method takes. */
const PodCallSchema = z.discriminatedUnion("method", [
  SendCall,
  FetchCall,
  PublishCall,
  TasksCall,
  z.object({ method: z.enum(["status", "cancel"]), peer: Text, task_id: Text }),
  z.object({ method: z.literal("connect"), peer: Text }),
  z.object({ method: z.literal("members") }),
]);

// ---- what a call answers ----

type SendResult = { task_id: string; state: TaskState; peer: string; node: string };
type FetchResult = { path: string; size: number };
type TaskSummary = {
  task_id: string;
  scope: "local" | "dispatched";
  peer: OrcaNodeId;
  state: TaskState | "unknown";
  updated_at: string;
  origin?: OrcaNodeId;
  reason?: string;
};
type TasksResult = {
  tasks: TaskSummary[];
  limit: number;
  has_more: boolean;
  next_before?: string;
};
/** The nodes this one knows, and the digest of what it vouches for. */
type Roster = { members: PeerView[]; members_digest: string };
type ConnectResult = Roster & { peer: string };

/**
 * The machine's node as the tool reaches it: the pod of this process (the host),
 * or, inside a task, the node's local routes.
 */
type ToolNode = { kind: "host"; pod: Pod } | { kind: "task"; local: LocalNode };

/**
 * This machine's node as a task session reaches it (design.md 4.5). The plugin inside a
 * task runs in another `dsh` process and has no node of its own, so its file
 * methods go through the node's local routes, at the address and with the token
 * the executor put into the task's environment, over TLS pinned to the node's id
 * like any other call to a node (design.md 6.2).
 */
export class LocalNode {
  private readonly tls = new PeerTls();

  constructor(
    private readonly url: string,
    /** The node's id: the key its certificate must carry. */
    private readonly node: string,
    private readonly token: string,
  ) {}

  /** The node the executor named; null when it named none (a task an older node started). */
  static fromEnv(): LocalNode | null {
    const url = process.env[NODE_URL_ENV];
    const node = process.env[NODE_ID_ENV];
    const token = process.env[NODE_TOKEN_ENV];
    return url && node && token ? new LocalNode(url, node, token) : null;
  }

  /** Have the node copy a file of this machine into its registry. */
  async publish(path: string, ttlS: number | undefined, signal: AbortSignal): Promise<PublishedFile> {
    const response = await this.call("/local/blobs", signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ttlS === undefined ? { path } : { path, ttl_s: ttlS }),
    });
    return parseOrThrow(
      PublishedFileSchema,
      await response.json(),
      (problem) => new Error(`this machine's node answered an unexpected publish reply: ${problem}`),
    );
  }

  /** A file any member published, as the node fetches it; the caller checks the bytes against the sha256. */
  async open(ref: BlobRef, signal: AbortSignal): Promise<OpenedBlob> {
    const response = await this.call(`/local/blobs/${ref.node}/${ref.blob_id}`, signal);
    if (response.body === null) throw new Error("this machine's node answered without the file");
    const length = response.headers.get("content-length");
    return {
      stream: Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      size: length === null ? undefined : Number(length),
    };
  }

  private async call(
    path: string,
    signal: AbortSignal,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> {
    const response = await nodeFetch(new URL(path, this.url), {
      ...init,
      headers: { ...init.headers, [LOCAL_TOKEN_HEADER]: this.token },
      signal,
      dispatcher: this.tls.route(this.node).dispatcher,
    });
    if (response.ok) return response;
    const answer = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(`this machine's node answered ${response.status}${answer?.message ? `: ${answer.message}` : ""}`);
  }
}

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
        execute: (args, exec) => this.execute(exec, () => this.runFile(PodTool.parseCall(FileCallSchema, args), exec)),
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
      execute: (args, exec) =>
        this.execute(exec, () => this.run(node.pod, PodTool.parseCall(PodCallSchema, args), exec)),
    });
  }

  /** Run one call as lossless JSON; an error names the tool, and keeps the pod error code and status it came with. */
  private async execute(exec: ToolRunContext, call: () => Promise<unknown>): Promise<JsonValue> {
    try {
      PodTool.throwIfAborted(exec.signal);
      // The call's own work observes the signal and settles when it stops (design.md 4.3).
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
  private async send(pod: Pod, args: z.output<typeof SendCall>, exec: ToolRunContext): Promise<SendResult> {
    const { signal } = exec;
    const permissionMode = PodTool.taskMode(args.permission_mode, this.sessionPolicy(exec)?.mode);
    const model =
      args.model === undefined ? undefined : (parseModelSpec(args.model, args.reasoning_effort) ?? undefined);
    if (args.model !== undefined && model === undefined) {
      throw new Error("model must be a provider/model string");
    }
    const orca = await PodTool.orca(pod, signal);
    const node = orca.mesh.resolve(args.peer);
    // `orca` rejected if the turn was cancelled while it waited; from here on the request observes the signal.
    const input: SubmitTaskInput = {
      message: { role: "user", parts: [{ kind: "text", text: args.text }] },
      metadata: {
        pod: {
          permission_mode: permissionMode,
          model,
          reasoning_effort: model === undefined ? args.reasoning_effort : undefined,
        },
      },
    };
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

  /** Save a file a member published, where the session sandbox lets it write (design.md 4.5). */
  private async fetch(args: z.output<typeof FetchCall>, exec: ToolRunContext): Promise<FetchResult> {
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
        : await (await PodTool.orca(node.pod, exec.signal)).mesh.require(ref.node).fetchBlob(ref.blob_id, exec.signal);
    await mkdir(dirname(output), { recursive: true });
    const { size } = await saveBlob(opened, output, ref.blob_id);
    return { path: output, size };
  }

  /** Copy a local file into this machine's node and name it (design.md 4.5); the copy lives for its TTL. */
  private async publish(args: z.output<typeof PublishCall>, exec: ToolRunContext): Promise<PublishedFile> {
    const policy = this.sessionPolicy(exec);
    if (policy === undefined) {
      throw new Error(
        "the session sandbox policy is not available, so it cannot be checked that this path may be published",
      );
    }
    const path = resolve(policy.workspaceRoot, args.path);
    if (policy.mode !== "danger-full-access") {
      const target = PodTool.resolvePublishTarget(path);
      const roots = [canonicalPath(policy.workspaceRoot), ...(policy.additionalWritableRoots ?? []).map(canonicalPath)];
      const allowed = roots.some((root) => isPathWithinRoot(root, target));
      if (!allowed) throw new Error(`the session sandbox (${policy.mode}) does not allow publishing ${path}`);
    }
    const { node } = this;
    if (node.kind === "task") return node.local.publish(path, args.ttl_s, exec.signal);
    // Publishing copies the file: `orca` rejects for a turn that is already gone, so it does not start.
    const { mesh } = await PodTool.orca(node.pod, exec.signal);
    return mesh.self.publish(path, args.ttl_s);
  }

  /** Resolve symlinks on `path`, falling back to canonicalising its parent so missing targets under symlinked dirs are still checked. */
  private static resolvePublishTarget(path: string): string {
    try {
      return realpathSync.native(path);
    } catch {
      return join(canonicalPath(dirname(path)), basename(path));
    }
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

  private async connect(pod: Pod, address: string, signal: AbortSignal): Promise<ConnectResult> {
    // Connecting persists the peer; do not start it for a turn that is already gone. The pod
    // joins it after any (re)start in progress, which is queued before it.
    PodTool.throwIfAborted(signal);
    const peer = await pod.addPeer(address);
    return { peer, ...PodTool.roster(await PodTool.orca(pod, signal)) };
  }

  /** Query local and/or dispatched tasks with SQLite index + LIMIT paging (default 10). */
  private async tasks(pod: Pod, call: z.output<typeof TasksCall>, signal: AbortSignal): Promise<TasksResult> {
    const orca = await PodTool.orca(pod, signal);
    const limit = call.limit ?? DEFAULT_RECENT_LIMIT;
    const offset = call.offset ?? 0;
    const scope = call.scope ?? "all";
    const peerId = call.peer === undefined ? undefined : orca.mesh.resolve(call.peer).id;
    const fetchCount = scope === "all" ? offset + limit + 1 : limit + 1;
    const sqlOffset = scope === "all" ? 0 : offset;

    const local: TaskSummary[] =
      scope === "dispatched" || call.state === "unknown"
        ? []
        : orca.tasks
            .list(fetchCount, {
              offset: sqlOffset,
              before: call.before,
              state: call.state,
              origin: peerId,
            })
            .map((view) => ({
              task_id: view.id,
              scope: "local",
              peer: orca.mesh.self.id,
              state: view.status.state,
              updated_at: view.status.timestamp,
              ...(view.metadata?.pod?.origin_orca_node === undefined
                ? {}
                : { origin: view.metadata.pod.origin_orca_node }),
              ...(view.status.reason === undefined ? {} : { reason: view.status.reason }),
            }));

    const localIds = new Set(local.map((row) => row.task_id));
    const dispatched: TaskSummary[] =
      scope === "local"
        ? []
        : orca.dispatches
            .recent(fetchCount, {
              offset: sqlOffset,
              before: call.before,
              state: call.state,
              node: peerId,
            })
            .filter((entry) => !localIds.has(entry.task_id))
            .map((entry) => ({
              task_id: entry.task_id,
              scope: "dispatched",
              peer: entry.node,
              state: entry.state,
              updated_at: entry.updated_at,
              ...(entry.last_error === undefined ? {} : { reason: entry.last_error }),
            }));

    const merged =
      scope === "all"
        ? [...local, ...dispatched].sort(
            (left, right) =>
              right.updated_at.localeCompare(left.updated_at) || right.task_id.localeCompare(left.task_id),
          )
        : scope === "local"
          ? local
          : dispatched;
    const start = scope === "all" ? offset : 0;
    const page = merged.slice(start, start + limit);
    const hasMore = merged.length > start + limit;
    const last = page.at(-1);
    return {
      tasks: page,
      limit,
      has_more: hasMore,
      ...(hasMore && last !== undefined ? { next_before: last.updated_at } : {}),
    };
  }

  /** Dispatch one call of the host's tool against the running node. */
  private async run(pod: Pod, call: z.output<typeof PodCallSchema>, exec: ToolRunContext): Promise<unknown> {
    const { signal } = exec;
    switch (call.method) {
      case "send":
        return this.send(pod, call, exec);
      case "fetch":
      case "publish":
        return this.runFile(call, exec);
      case "status":
      case "cancel": {
        const node = (await PodTool.orca(pod, signal)).mesh.resolve(call.peer);
        const view =
          call.method === "status"
            ? await node.getTask(call.task_id, signal)
            : await node.cancelTask(call.task_id, signal);
        return { ...view, terminal: isTerminal(view.status.state) };
      }
      case "tasks":
        return this.tasks(pod, call, signal);
      case "members": {
        const orca = await PodTool.orca(pod, signal);
        return { self: orca.mesh.self.selfRecord(), ...PodTool.roster(orca) };
      }
      case "connect":
        return this.connect(pod, call.peer, signal);
    }
  }

  private runFile(call: z.output<typeof FileCallSchema>, exec: ToolRunContext): Promise<FetchResult | PublishedFile> {
    return call.method === "fetch" ? this.fetch(call, exec) : this.publish(call, exec);
  }

  /** The nodes `orca` knows besides itself, and the digest of what it vouches for. */
  private static roster(orca: Orca): Roster {
    return { members: orca.mesh.peers().map((node) => node.view()), members_digest: orca.mesh.digest() };
  }

  /** Parse a call; an error names the argument and what is wrong with it. */
  private static parseCall<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
    return parseOrThrow(schema, args, (problem) => new Error(problem));
  }

  /**
   * The mode a dispatched task starts with: the session's, or a narrower one the
   * caller names. A wider one is refused: the target asks the origin for an
   * upgrade when the task needs it (design.md 6.4). A session whose mode cannot be read
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
   * The pod's running node, once any (re)start in progress is over; the tool call
   * fails when the node is not usable. A restart is the host's work, not this
   * call's, so a cancelled turn stops waiting for it right away. Only this wait is
   * cut short: a tool settles only after its own work has stopped (dsh-tools
   * `execute`), so the methods forward the signal to their requests and finish on
   * their own.
   */
  private static orca(pod: Pod, signal: AbortSignal): Promise<Orca> {
    if (signal.aborted) return Promise.reject(abortError("cancelled by the caller"));
    const wait = pod.orca();
    return new Promise<Orca>((resolve, reject) => {
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
