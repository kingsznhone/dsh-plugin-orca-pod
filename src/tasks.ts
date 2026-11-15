import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deriveChildGrant, validatePodMetadata } from "./chain.ts";
import type { NodeIdentity } from "./identity.ts";
import { verifyGrant } from "./crypto.ts";
import { echoScriptFrom, type EchoRelay, type ExecutorEvent, type LocalExecutor } from "./executor.ts";
import {
  isModelSelection,
  isTerminal,
  modelSelectionOf,
  narrowPermissionMode,
  newTaskId,
  permissionModeOf,
  reasoningEffortOf,
  TaskError,
  type A2AMessage,
  type BusyState,
  type ModelSelection,
  type PermissionMode,
  type PermissionRequest,
  type SignedGrant,
  type SubmitTaskInput,
  type TaskRunner,
  type TaskState,
  type TaskView,
} from "./protocol.ts";
import { createMemoryTaskStore, type BlobStore, type TaskStore } from "./storage.ts";
import type { Workspace } from "./workspace.ts";

type Running = {
  view: TaskView;
  metadata: Record<string, unknown> | undefined;
  origin_orca_node: string;
  prompt: string;
  created_at: string;
  since: string;
  abort: AbortController;
  iterator: AsyncGenerator<ExecutorEvent, void, unknown> | null;
  ttl: ReturnType<typeof setTimeout> | null;
  /** Task TTL in seconds; paused while the task waits for input, re-armed on resume. */
  ttl_s: number;
  /** Auto-reject timer for a parked permission request; null means wait forever (§7.12). */
  permission_timer: ReturnType<typeof setTimeout> | null;
  /** Set while the task waits for a human decision on one tool (§7.11). */
  pending_permission: PermissionRequest | null;
  /** Child task this task escalates for; set only by a relay suspension (§7.12). */
  relay: EchoRelay | null;
  /** Set when the task itself is parked because a child needs an approval (§7.12 escalation). */
  pending_escalation: EchoRelay | null;
  /** Materialized inputs directory, removed when the task reaches a terminal state (§6.7). */
  inputs_dir: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function messageText(message: A2AMessage): string {
  return message.parts
    .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
}

function cloneView(view: TaskView): TaskView {
  return JSON.parse(JSON.stringify(view)) as TaskView;
}

function textMessage(text: string): A2AMessage {
  return { role: "agent", parts: [{ kind: "text", text }] };
}

/** Keep the inline summary under the local cap; longer text is cut with a marker (§6.11). */
function truncateMessage(message: A2AMessage, maxBytes: number): A2AMessage {
  const text = messageText(message);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return message;
  const marker = `\n…[summary truncated at ${maxBytes} bytes]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let cut = "";
  for (const char of text) {
    if (Buffer.byteLength(cut + char, "utf8") > budget) break;
    cut += char;
  }
  return { role: message.role, parts: [{ kind: "text", text: cut + marker }] };
}

/** Task inputs are content-addressed blobs referenced by name (§6.7). */
export type TaskInputRef = { blob_id: string; name: string };

const INPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_MAX_INPUT_FILES = 32;
const DEFAULT_MAX_INPUT_BYTES = 512 * 1024 * 1024;

/** Validate `metadata.pod.inputs`; duplicates and unsafe names are rejected (§6.7). */
export function taskInputs(metadata: SubmitTaskInput["metadata"]): TaskInputRef[] {
  const pod = metadata?.["pod"] as Record<string, unknown> | undefined;
  const raw = pod?.["inputs"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new TaskError("bad_request", "pod.inputs must be an array");
  const seen = new Set<string>();
  const inputs: TaskInputRef[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TaskError("bad_request", "pod.inputs entries must be objects");
    }
    const record = item as Record<string, unknown>;
    const blobId = record["blob_id"];
    const name = record["name"];
    if (typeof blobId !== "string" || !/^[0-9a-f]{64}$/.test(blobId)) {
      throw new TaskError("bad_request", "pod.inputs[].blob_id must be a sha256 blob id");
    }
    if (typeof name !== "string" || !INPUT_NAME_PATTERN.test(name) || name === "." || name === "..") {
      throw new TaskError("bad_request", `pod.inputs[].name "${String(name)}" is not a safe file name`);
    }
    if (seen.has(name)) throw new TaskError("duplicate_input_name", `input name ${name} appears twice`);
    seen.add(name);
    inputs.push({ blob_id: blobId, name });
  }
  return inputs;
}

/** Relative paths listed after the task text; cwd is the group workspace root (§6.7). */
function promptWithAttachments(prompt: string, taskId: string, inputs: TaskInputRef[], notes: string[]): string {
  const sections: string[] = [];
  if (inputs.length > 0) {
    const list = inputs.map((input) => `- inputs/${taskId}/${input.name}`).join("\n");
    sections.push(
      `[orca-pod] Task inputs are in the current directory; they are deleted when the task ends.\n${list}`,
    );
  }
  if (notes.length > 0) {
    const list = notes.map((note) => `- ${note}`).join("\n");
    sections.push(`[orca-pod] Notes from earlier tasks in this workgroup (read before you start):\n${list}`);
  }
  return sections.length === 0 ? prompt : `${prompt}\n\n---\n${sections.join("\n\n")}`;
}

/** Top-level files in the workgroup `notes/` directory, capped for the prompt appendix (§6.7). */
function workspaceNotes(workspace: Workspace | null): string[] {
  if (workspace === null) return [];
  try {
    return readdirSync(workspace.notes, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `notes/${entry.name}`)
      .sort()
      .slice(0, 20);
  } catch {
    return [];
  }
}
export type TaskRunnerDeps = {
  executor: LocalExecutor;
  blobs: BlobStore;
  /** Durable store (§5.5). Defaults to memory so protocol tests stay isolated. */
  store?: TaskStore;
  /** Group workspace; becomes the executor cwd when present (§6.7). */
  workspace?: Workspace;
  defaultTtlS?: number;
  /** Identity and key needed to build permission requests and check grants (§7.11). */
  selfOrcaNodeId?: string;
  workgroupId?: string;
  key?: Buffer;
  /** Auto-reject a parked permission request after this many seconds; unset waits forever (§7.12). */
  permissionTtlS?: number;
  /** Local ceiling for inherited origin modes; undefined means no local cap (§7.10). */
  permissionMode?: PermissionMode;
  /** Hard cap on task lifetime; peers see it as max_task_ttl_s (§6.9). Default 3600s. */
  taskTimeoutS?: number;
  /** Inline result summary cap in bytes; longer summaries are truncated (§6.11). Default 32 KiB. */
  resultMaxBytes?: number;
  /** Data root, used by executors that need to point an agent at the local CLI (§6.14). */
  dataRoot?: string;
  /** Max inputs one origin may attach in one task (§6.7). Default 32. */
  maxInputFiles?: number;
  /** Max total input bytes per task (§6.7). Default 512 MiB. */
  maxInputBytes?: number;
  /** Sends a control message to a child task (grant/denial downward, §7.12). */
  sendTaskMessage?: (peerUrl: string, taskId: string, message: A2AMessage) => Promise<void>;
  /** Called after every observable task change, for the UI event bus (§9.2). */
  onEvent?: (view: TaskView) => void;
  /** Local ACP session defaults when an origin does not override them (§6.15). */
  modelDefaults?: () => {
    model?: ModelSelection | null;
    reasoningEffort?: string | null;
  };
};

/**
 * Owns task records and drives executor events into the A2A state machine
 * (§4.8). One orca node runs one task at a time (§6.9): busy => orca_node_busy.
 */
export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const tasks = new Map<string, Running>();
  const store = deps.store ?? createMemoryTaskStore();
  const defaultTtlS = deps.defaultTtlS ?? 3600;
  const taskTimeoutS = deps.taskTimeoutS ?? defaultTtlS;
  const resultMaxBytes = deps.resultMaxBytes ?? 32 * 1024;
  const permissionTtlS = deps.permissionTtlS;
  const selfOrcaNodeId = deps.selfOrcaNodeId ?? "unknown";
  const workspace = deps.workspace ?? null;
  const maxInputFiles = deps.maxInputFiles ?? DEFAULT_MAX_INPUT_FILES;
  const maxInputBytes = deps.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  let activeTaskId: string | null = null;

  /** Notify UI listeners after a state change; the bus catches listener errors. */
  function emit(rec: Running): void {
    deps.onEvent?.(cloneView(rec.view));
  }

  function copyBlobTo(blobId: string, destination: string): boolean {
    if (deps.blobs.copyTo !== undefined) return deps.blobs.copyTo(blobId, destination);
    const blob = deps.blobs.get(blobId);
    if (!blob) return false;
    writeFileSync(destination, blob.bytes);
    return true;
  }

  /**
   * Copy declared inputs into `inputs/<task_id>/` before the task exists (§6.7).
   * Throws — and leaves no directory behind — when a blob is missing or a cap
   * is exceeded, so a bad request never creates a task.
   */
  function materializeInputs(taskId: string, inputs: TaskInputRef[]): string | null {
    if (inputs.length === 0) return null;
    if (workspace === null) throw new TaskError("bad_request", "task inputs require a group workspace");
    if (inputs.length > maxInputFiles) {
      throw new TaskError("too_many_inputs", `at most ${maxInputFiles} inputs per task`);
    }
    let total = 0;
    for (const input of inputs) {
      const read = deps.blobs.openRead?.(input.blob_id);
      const size = read?.size ?? deps.blobs.get(input.blob_id)?.size;
      read?.stream.destroy();
      if (size === undefined) throw new TaskError("input_blob_missing", `unknown blob ${input.blob_id}`);
      total += size;
      if (total > maxInputBytes) {
        throw new TaskError("inputs_too_large", `task inputs exceed ${maxInputBytes} bytes`);
      }
    }
    const dir = workspace.inputDir(taskId);
    mkdirSync(dir, { recursive: true });
    for (const input of inputs) {
      if (copyBlobTo(input.blob_id, join(dir, input.name))) continue;
      rmSync(dir, { recursive: true, force: true });
      throw new TaskError("input_blob_missing", `unknown blob ${input.blob_id}`);
    }
    return dir;
  }

  function chainOf(rec: Running): string[] {
    const pod = rec.metadata?.["pod"] as { chain?: unknown } | undefined;
    const chain = pod?.chain;
    return Array.isArray(chain) ? chain.filter((hop): hop is string => typeof hop === "string") : [];
  }

  function suspendMessage(rec: Running, suspend: ExecutorEvent & { type: "suspend" }): A2AMessage {
    if (suspend.suspend.kind === "blocked") {
      return {
        role: "agent",
        parts: [
          {
            kind: "data",
            data: {
              blocked: {
                reason: suspend.suspend.reason,
                question: suspend.suspend.question,
                ...(suspend.suspend.options ? { options: suspend.suspend.options } : {}),
              },
            },
          },
        ],
      };
    }
    const suspended = suspend.suspend;
    const relay = suspended.relay;
    const request: PermissionRequest = {
      request_id: randomUUID(),
      task_id: rec.view.id,
      tool: suspended.tool,
      requested: suspended.requested,
      requested_by: selfOrcaNodeId,
      via: chainOf(rec),
      ...(relay ? { upstream: [relay.request.requested_by] } : {}),
      // No expiry by default: the origin waits however long the human takes (§7.12).
      ...(permissionTtlS === undefined
        ? {}
        : { expires_at: new Date(Date.now() + permissionTtlS * 1000).toISOString() }),
    };
    rec.pending_permission = request;
    rec.relay = relay ?? null;
    return { role: "agent", parts: [{ kind: "data", data: { permission_request: request } }] };
  }

  /** Sends a grant or denial down to the child task a relay suspension waits on. */
  async function sendRelayControl(relay: EchoRelay, data: Record<string, unknown>): Promise<void> {
    if (deps.sendTaskMessage === undefined) {
      throw new TaskError("bad_request", "this orca node has no task relay transport");
    }
    const message: A2AMessage = {
      role: "user",
      parts: [{ kind: "data", data }],
      taskId: relay.task_id,
      messageId: randomUUID(),
    };
    await deps.sendTaskMessage(relay.peer, relay.task_id, message);
  }

  /** Derive a child grant, resume the child task, then continue this task (§7.12). */
  async function relayThenPump(
    rec: Running,
    relay: EchoRelay,
    parent: SignedGrant,
    message: A2AMessage,
  ): Promise<void> {
    try {
      const childGrant = deriveChildGrant({
        parent,
        request: relay.request,
        selfOrcaNodeId,
      });
      await sendRelayControl(relay, { grant: childGrant });
      void pump(rec, message);
    } catch (error) {
      if (rec.abort.signal.aborted) return;
      const code = error instanceof TaskError ? error.code : "relay_failed";
      const text = error instanceof Error ? error.message : String(error);
      finish(rec, "failed", textMessage(`relay to child failed: ${text}`), code);
    }
  }

  /**
   * Derive a child grant from this task's approval and hand it to the child,
   * then put this task back to work. The executor kept running while parked, so
   * unlike `relayThenPump` this must not feed anything into the iterator (§7.12).
   */
  async function escalationThenContinue(
    rec: Running,
    relay: EchoRelay,
    parent: SignedGrant,
  ): Promise<void> {
    try {
      const childGrant = deriveChildGrant({
        parent,
        request: relay.request,
        selfOrcaNodeId,
      });
      await sendRelayControl(relay, { grant: childGrant });
    } catch (error) {
      if (rec.abort.signal.aborted) return;
      const code = error instanceof TaskError ? error.code : "relay_failed";
      const text = error instanceof Error ? error.message : String(error);
      finish(rec, "failed", textMessage(`escalation to child failed: ${text}`), code);
    }
  }

  /** Returns the failure reason, or null when the grant matches what was asked. */
  function checkGrant(rec: Running, grant: SignedGrant, pending: PermissionRequest): string | null {
    if (!verifyGrant(grant.origin_orca_node, grant)) return "grant_invalid";
    if (deps.workgroupId !== undefined && grant.workgroup_id !== deps.workgroupId) return "grant_invalid";
    if (grant.tool !== pending.tool) return "grant_invalid";
    if (Number.isNaN(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now()) {
      return "grant_expired";
    }
    // Direct decision: the origin signed this very task for this very node.
    if (grant.task_id === rec.view.id && grant.target_orca_node === selfOrcaNodeId) return null;
    // Delegated decision (§7.12): the origin signed for an ancestor of this
    // task's delegation chain; middle nodes forward that grant unchanged.
    const chain = chainOf(rec);
    const delegated =
      grant.target_orca_node !== selfOrcaNodeId &&
      chain.includes(grant.target_orca_node) &&
      grant.chain.every((hop, index) => chain[index] === hop);
    return delegated ? null : "grant_invalid";
  }

  /** Data controls a resume may carry; anything else is ordinary task input. */
  function resumeControl(message: A2AMessage): { grant?: SignedGrant; denied?: string } {
    for (const part of message.parts) {
      if (part.kind !== "data") continue;
      const data = part.data as { grant?: unknown; permission_denied?: unknown; reason?: unknown };
      if (data.permission_denied === true) {
        return { denied: typeof data.reason === "string" ? data.reason : "denied by origin" };
      }
      if (typeof data.grant === "object" && data.grant !== null) {
        return { grant: data.grant as SignedGrant };
      }
    }
    return {};
  }

  function persist(rec: Running): void {
    store.save({
      view: cloneView(rec.view),
      origin_orca_node: rec.origin_orca_node,
      created_at: rec.created_at,
      updated_at: nowIso(),
    });
  }

  function releaseSlot(rec: Running): void {
    if (activeTaskId === rec.view.id) activeTaskId = null;
  }

  function clearTtl(rec: Running): void {
    if (rec.ttl) {
      clearTimeout(rec.ttl);
      rec.ttl = null;
    }
  }

  function clearPermissionTimer(rec: Running): void {
    if (rec.permission_timer) {
      clearTimeout(rec.permission_timer);
      rec.permission_timer = null;
    }
  }

  /** Task TTL is paused while the task waits for input; resume re-arms it from now. */
  function armTtl(rec: Running): void {
    clearTtl(rec);
    rec.ttl = setTimeout(() => {
      if (!isTerminal(rec.view.status.state)) {
        // Terminal state first: the abort that follows rejects the executor's
        // iterator, and pump() must not overwrite this reason with "canceled".
        finish(rec, "failed", textMessage("task ttl exceeded"), "timeout");
        rec.abort.abort();
      }
    }, rec.ttl_s * 1000);
    rec.ttl.unref?.();
  }

  /**
   * Only when the node configures an approval timeout does a parked request
   * expire by itself; by default the origin may take as long as it needs (§7.12).
   */
  function armPermissionTimer(rec: Running): void {
    clearPermissionTimer(rec);
    if (permissionTtlS === undefined) return;
    rec.permission_timer = setTimeout(() => {
      if (rec.pending_permission === null) return;
      const parked = rec.pending_escalation;
      if (parked !== null) {
        rec.pending_escalation = null;
        void sendRelayControl(parked, { permission_denied: true, reason: "permission_timeout" }).catch(() => {});
      }
      const relay = rec.relay;
      if (relay !== null) {
        rec.relay = null;
        void sendRelayControl(relay, { permission_denied: true, reason: "permission_timeout" }).catch(() => {});
      }
      rec.pending_permission = null;
      finish(rec, "failed", textMessage("permission request timed out"), "permission_timeout");
    }, permissionTtlS * 1000);
    rec.permission_timer.unref?.();
  }

  function finish(rec: Running, state: TaskState, message?: A2AMessage, reason?: string): void {
    const summary = message === undefined ? undefined : truncateMessage(message, resultMaxBytes);
    rec.view.status = { state, timestamp: nowIso(), ...(summary ? { message: summary } : {}), ...(reason ? { reason } : {}) };
    clearTtl(rec);
    clearPermissionTimer(rec);
    releaseSlot(rec);
    persist(rec);
    if (rec.inputs_dir !== null) {
      rmSync(rec.inputs_dir, { recursive: true, force: true });
      rec.inputs_dir = null;
    }
    emit(rec);
  }

  async function pump(rec: Running, resume?: A2AMessage): Promise<void> {
    const inheritedMode = permissionModeOf(rec.metadata);
    const permissionMode =
      inheritedMode === undefined
        ? deps.permissionMode
        : deps.permissionMode === undefined
          ? inheritedMode
          : narrowPermissionMode(deps.permissionMode, inheritedMode);
    const requestedModel = modelSelectionOf(rec.metadata);
    const requestedEffort = reasoningEffortOf(rec.metadata);
    const supportsModels = deps.executor.supportsModelSelection === true;
    if (requestedModel !== undefined && !supportsModels) {
      finish(
        rec,
        "failed",
        textMessage(
          `this orca node cannot select a model (${requestedModel.provider}/${requestedModel.model}); only the ACP executor supports per-task models`,
        ),
        "model_unsupported",
      );
      return;
    }
    if (requestedEffort !== undefined && !supportsModels) {
      finish(
        rec,
        "failed",
        textMessage(
          `this orca node cannot select reasoning effort "${requestedEffort}"; only the ACP executor supports per-task models`,
        ),
        "model_unsupported",
      );
      return;
    }
    // Local defaults apply when the origin only overrides part of the selection
    // (or nothing at all). ACP always receives them so a resumed session cannot
    // keep a previous task's model or effort (§6.15).
    const defaults = supportsModels ? deps.modelDefaults?.() : undefined;
    const model = requestedModel ?? defaults?.model ?? undefined;
    const reasoningEffort = requestedEffort ?? defaults?.reasoningEffort ?? undefined;
    const iterator =
      rec.iterator ??
      deps.executor.run(
        {
          taskId: rec.view.id,
          contextId: rec.view.contextId,
          prompt: rec.prompt,
          originOrcaNode: rec.origin_orca_node,
          ...(deps.selfOrcaNodeId ? { selfOrcaNodeId: deps.selfOrcaNodeId } : {}),
          ...(workspace ? { workspaceDir: workspace.root, podDir: workspace.state } : {}),
          ...(deps.dataRoot ? { dataRootDir: deps.dataRoot } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(model === null || model === undefined ? {} : { model }),
          ...(reasoningEffort === null || reasoningEffort === undefined ? {} : { reasoningEffort }),
          metadata: rec.metadata,
        },
        rec.abort.signal,
      );
    rec.iterator = iterator;
    rec.view.status = { state: "working", timestamp: nowIso() };
    persist(rec);
    emit(rec);
    try {
      let step = resume === undefined ? await iterator.next() : await iterator.next(resume);
      while (!step.done) {
        const event = step.value;
        if (event.type === "suspend") {
          rec.view.status = { state: "input-required", timestamp: nowIso(), message: suspendMessage(rec, event) };
          clearTtl(rec);
          armPermissionTimer(rec);
          releaseSlot(rec);
          persist(rec);
          emit(rec);
          return;
        }
        if (event.type === "artifact") {
          const blob = deps.blobs.put(Buffer.from(event.content, "utf8"), { name: event.name });
          rec.view.artifacts = [
            ...(rec.view.artifacts ?? []),
            { artifactId: blob.blob_id, name: event.name, mediaType: "text/plain", bytes: blob.size },
          ];
          persist(rec);
          emit(rec);
        } else if (event.type === "completed") {
          if (event.usage) rec.view.usage = event.usage;
          finish(rec, "completed", textMessage(event.text));
          return;
        } else if (event.type === "failed") {
          if (event.usage) rec.view.usage = event.usage;
          finish(rec, "failed", textMessage(event.text), event.reason ?? "executor_error");
          return;
        }
        step = await iterator.next();
      }
      finish(rec, "failed", textMessage("executor exited without a terminal event"), "executor_exited");
    } catch (error) {
      // A watchdog (hard TTL, cancel) may have finished the task already;
      // its reason wins over the executor's abort error.
      if (isTerminal(rec.view.status.state)) return;
      if (rec.abort.signal.aborted) {
        finish(rec, "canceled", undefined, rec.view.status.reason ?? "canceled");
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      finish(rec, "failed", textMessage(reason), "executor_error");
    }
  }

  /**
   * The task view tells every reader which node created the task, so the panel
   * can show its origin without a second lookup. `rec.metadata` stays exactly
   * what the caller sent; only the returned/stored view gets the extra key.
   */
  function viewMetadataWithOrigin(
    metadata: Record<string, unknown> | undefined,
    origin: string,
  ): Record<string, unknown> {
    const base = metadata ?? {};
    const pod = (base["pod"] as Record<string, unknown> | undefined) ?? {};
    return { ...base, pod: { ...pod, origin } };
  }

  function submit(input: SubmitTaskInput): TaskView {
    if (activeTaskId !== null) throw new TaskError("orca_node_busy", "orca node is busy with another task");
    validatePodMetadata(input.metadata, selfOrcaNodeId);
    try {
      echoScriptFrom(input.metadata); // validate before a task exists (§6.3)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskError("bad_echo_script", message);
    }
    const inputRefs = taskInputs(input.metadata);
    const id = newTaskId();
    const contextId = input.message.contextId ?? id;
    const createdAt = nowIso();
    const inputsDir = materializeInputs(id, inputRefs);
    const requestedTtl = Number(
      input.metadata?.["pod"] && (input.metadata["pod"] as { task_ttl_s?: number }).task_ttl_s,
    );
    const ttlS =
      Number.isFinite(requestedTtl) && requestedTtl > 0 ? Math.min(requestedTtl, taskTimeoutS) : taskTimeoutS;
    const rec: Running = {
      view: {
        kind: "task",
        id,
        contextId,
        status: { state: "submitted", timestamp: createdAt },
        metadata: viewMetadataWithOrigin(input.metadata, input.originOrcaNode ?? selfOrcaNodeId),
      },
      metadata: input.metadata,
      origin_orca_node: input.originOrcaNode ?? "unknown",
      prompt: promptWithAttachments(messageText(input.message), id, inputRefs, workspaceNotes(workspace)),
      created_at: createdAt,
      since: createdAt,
      abort: new AbortController(),
      iterator: null,
      ttl: null,
      ttl_s: ttlS,
      permission_timer: null,
      pending_permission: null,
      relay: null,
      pending_escalation: null,
      inputs_dir: inputsDir,
    };
    activeTaskId = id;
    tasks.set(id, rec);
    persist(rec);
    armTtl(rec);
    emit(rec);
    void pump(rec);
    return cloneView(rec.view);
  }

  function get(taskId: string): TaskView | null {
    const rec = tasks.get(taskId);
    if (rec) return cloneView(rec.view);
    const stored = store.load(taskId);
    return stored ? cloneView(stored.view) : null;
  }

  function originOf(taskId: string): string | null {
    const rec = tasks.get(taskId);
    if (rec) return rec.origin_orca_node;
    return store.load(taskId)?.origin_orca_node ?? null;
  }

  /**
   * Local tasks for the UI task panel (§9.2): newest live records first, then
   * the persisted store fills the remaining budget. Terminal tasks stay in the
   * store until it is pruned, so history survives a restart.
   */
  function list(limit = 200): TaskView[] {
    const views: TaskView[] = [];
    const seen = new Set<string>();
    const live = [...tasks.values()].sort((left, right) => right.view.id.localeCompare(left.view.id));
    for (const rec of live) {
      if (views.length >= limit) break;
      views.push(cloneView(rec.view));
      seen.add(rec.view.id);
    }
    if (views.length < limit) {
      const stored = store.list().sort((left, right) => right.updated_at.localeCompare(left.updated_at));
      for (const persisted of stored) {
        if (views.length >= limit) break;
        if (seen.has(persisted.view.id)) continue;
        views.push(cloneView(persisted.view));
      }
    }
    return views;
  }

  function resume(taskId: string, message: A2AMessage, callerOrcaNode?: string): TaskView {
    const rec = tasks.get(taskId);
    if (!rec) {
      if (!store.load(taskId)) throw new TaskError("task_not_found", `unknown task ${taskId}`);
      throw new TaskError("bad_request", "task is not input-required");
    }
    // Only the task's origin drives it; other workgroup members may read it (§5.2).
    if (callerOrcaNode !== undefined && callerOrcaNode !== rec.origin_orca_node) {
      throw new TaskError("not_task_origin", `task ${taskId} belongs to another origin`);
    }
    if (rec.view.status.state !== "input-required") {
      throw new TaskError("bad_request", "task is not input-required");
    }
    if (activeTaskId !== null && activeTaskId !== taskId) {
      throw new TaskError("orca_node_busy", "orca node is busy with another task");
    }
    // A permission suspension ends only with a grant or an explicit denial (§7.11).
    let grant: SignedGrant | undefined;
    let escalation: EchoRelay | null = null;
    if (rec.pending_permission !== null) {
      const control = resumeControl(message);
      const parked = rec.pending_escalation;
      if (control.denied !== undefined) {
        if (rec.relay !== null) {
          const relay = rec.relay;
          rec.relay = null;
          void sendRelayControl(relay, { permission_denied: true, reason: control.denied }).catch(() => {});
        }
        if (parked !== null) {
          rec.pending_escalation = null;
          void sendRelayControl(parked, { permission_denied: true, reason: control.denied }).catch(() => {});
        }
        finish(rec, "failed", textMessage(`permission denied: ${control.denied}`), "permission_denied");
        return cloneView(rec.view);
      }
      if (control.grant === undefined) {
        throw new TaskError("bad_request", "resume of a permission request needs a grant or a denial");
      }
      const failure = checkGrant(rec, control.grant, rec.pending_permission);
      if (failure !== null) {
        finish(rec, "failed", textMessage(`permission grant rejected: ${failure}`), failure);
        return cloneView(rec.view);
      }
      grant = control.grant;
      rec.pending_permission = null;
      if (parked !== null) {
        rec.pending_escalation = null;
        escalation = parked;
      }
    }
    // The wait is over: stop the approval alarm and let the task TTL run again.
    clearPermissionTimer(rec);
    armTtl(rec);
    if (escalation !== null && grant !== undefined) {
      // The parked task's executor never stopped, so re-acquire the slot and
      // hand the derived child grant to the child without touching the iterator.
      if (activeTaskId !== null && activeTaskId !== taskId) {
        finish(rec, "failed", textMessage("orca node is busy with another task"), "orca_node_busy");
        return cloneView(rec.view);
      }
      activeTaskId = taskId;
      rec.view.status = { state: "working", timestamp: nowIso() };
      persist(rec);
      emit(rec);
      void escalationThenContinue(rec, escalation, grant);
      return cloneView(rec.view);
    }
    activeTaskId = taskId;
    const relay = rec.relay;
    rec.relay = null;
    if (relay !== null && grant !== undefined) {
      rec.view.status = { state: "working", timestamp: nowIso() };
      persist(rec);
      emit(rec);
      void relayThenPump(rec, relay, grant, message);
    } else {
      void pump(rec, message);
    }
    return cloneView(rec.view);
  }

  /**
   * Park a running task because a child task it delegated to needs a permission
   * only this task's origin can grant (§7.12). The executor keeps running; the
   * task only surfaces an upstream `permission_request` and frees the slot.
   */
  function escalate(taskId: string, relay: EchoRelay, callerOrcaNode?: string): TaskView {
    if (callerOrcaNode !== undefined && callerOrcaNode !== selfOrcaNodeId) {
      throw new TaskError("bad_request", "escalate is a local control invoked by this orca node");
    }
    const rec = tasks.get(taskId);
    if (!rec) throw new TaskError("task_not_found", `unknown task ${taskId}`);
    if (rec.view.status.state !== "working") {
      throw new TaskError("bad_request", "only a running task can escalate");
    }
    if (rec.pending_permission !== null || rec.pending_escalation !== null) {
      throw new TaskError("bad_request", "task is already waiting for a decision");
    }
    if (
      typeof relay.peer !== "string" || relay.peer.length === 0 ||
      typeof relay.task_id !== "string" || relay.task_id.length === 0 ||
      typeof relay.request !== "object" || relay.request === null ||
      typeof relay.request.requested_by !== "string" || typeof relay.request.tool !== "string"
    ) {
      throw new TaskError("bad_request", "escalate needs a child relay with peer, task_id and request");
    }
    const request: PermissionRequest = {
      request_id: randomUUID(),
      task_id: rec.view.id,
      tool: relay.request.tool,
      requested: relay.request.requested ?? {},
      requested_by: selfOrcaNodeId,
      via: chainOf(rec),
      upstream: [relay.request.requested_by],
      ...(permissionTtlS === undefined
        ? {}
        : { expires_at: new Date(Date.now() + permissionTtlS * 1000).toISOString() }),
    };
    rec.pending_permission = request;
    rec.pending_escalation = { peer: relay.peer, task_id: relay.task_id, request: relay.request };
    rec.view.status = {
      state: "input-required",
      timestamp: nowIso(),
      message: { role: "agent", parts: [{ kind: "data", data: { permission_request: request } }] },
    };
    clearTtl(rec);
    armPermissionTimer(rec);
    releaseSlot(rec);
    persist(rec);
    emit(rec);
    return cloneView(rec.view);
  }

  function cancel(taskId: string): TaskView {
    const rec = tasks.get(taskId);
    if (!rec) {
      const stored = store.load(taskId);
      if (!stored) throw new TaskError("task_not_found", `unknown task ${taskId}`);
      return cloneView(stored.view);
    }
    if (isTerminal(rec.view.status.state)) return cloneView(rec.view);
    if (rec.relay !== null) {
      const relay = rec.relay;
      rec.relay = null;
      void sendRelayControl(relay, { permission_denied: true, reason: "task canceled" }).catch(() => {});
    }
    if (rec.pending_escalation !== null) {
      const parked = rec.pending_escalation;
      rec.pending_escalation = null;
      void sendRelayControl(parked, { permission_denied: true, reason: "task canceled" }).catch(() => {});
    }
    rec.abort.abort();
    finish(rec, "canceled", undefined, "canceled");
    return cloneView(rec.view);
  }

  function busy(): BusyState | null {
    if (activeTaskId === null) return null;
    const rec = tasks.get(activeTaskId);
    if (!rec) return null;
    return { task_id: rec.view.id, origin_orca_node: rec.origin_orca_node, since: rec.since };
  }

  /** §8.3: a restart never silently resumes work; every unfinished task fails. */
  function recover(): number {
    let count = 0;
    for (const stored of store.list()) {
      if (isTerminal(stored.view.status.state)) continue;
      const message = textMessage("task was interrupted by an orca node restart");
      store.save({
        view: {
          ...stored.view,
          status: { state: "failed", timestamp: nowIso(), message, reason: "node_restart" },
        },
        origin_orca_node: stored.origin_orca_node,
        created_at: stored.created_at,
        updated_at: nowIso(),
      });
      count += 1;
    }
    return count;
  }

  return { submit, get, list, originOf, resume, escalate, cancel, busy, recover };
}
