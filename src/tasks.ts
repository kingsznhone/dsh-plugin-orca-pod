import { randomUUID } from "node:crypto";
import { deriveChildGrant, validatePodMetadata } from "./chain.ts";
import { verifyGrant } from "./crypto.ts";
import { echoScriptFrom, type EchoRelay, type ExecutorEvent, type LocalExecutor } from "./executor.ts";
import {
  isTerminal,
  newTaskId,
  TaskError,
  type A2AMessage,
  type BusyState,
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
  /** Largest `pod.hop` this orca node accepts; default 0 (single hop only, §5.1). */
  maxHop?: number;
  /** Sends a control message to a child task (grant/denial downward, §7.12). */
  sendTaskMessage?: (peerUrl: string, taskId: string, message: A2AMessage) => Promise<void>;
};

/**
 * Owns task records and drives executor events into the A2A state machine
 * (§4.8). One orca node runs one task at a time (§6.9): busy => orca_node_busy.
 */
export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const tasks = new Map<string, Running>();
  const store = deps.store ?? createMemoryTaskStore();
  const defaultTtlS = deps.defaultTtlS ?? 3600;
  const permissionTtlS = deps.permissionTtlS;
  const selfOrcaNodeId = deps.selfOrcaNodeId ?? "unknown";
  let activeTaskId: string | null = null;

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
      if (deps.key === undefined) throw new TaskError("bad_request", "relay needs the workgroup key");
      const childGrant = deriveChildGrant({
        key: deps.key,
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
      if (deps.key === undefined) throw new TaskError("bad_request", "escalation needs the workgroup key");
      const childGrant = deriveChildGrant({
        key: deps.key,
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
    if (deps.key === undefined || !verifyGrant(deps.key, grant)) return "grant_invalid";
    if (grant.task_id !== rec.view.id) return "grant_invalid";
    if (grant.target_orca_node !== selfOrcaNodeId) return "grant_invalid";
    if (deps.workgroupId !== undefined && grant.workgroup_id !== deps.workgroupId) return "grant_invalid";
    if (grant.tool !== pending.tool) return "grant_invalid";
    if (Number.isNaN(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now()) {
      return "grant_expired";
    }
    return null;
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
        rec.abort.abort();
        finish(rec, "failed", textMessage("task ttl exceeded"), "timeout");
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
    rec.view.status = { state, timestamp: nowIso(), ...(message ? { message } : {}), ...(reason ? { reason } : {}) };
    clearTtl(rec);
    clearPermissionTimer(rec);
    releaseSlot(rec);
    persist(rec);
  }

  async function pump(rec: Running, resume?: A2AMessage): Promise<void> {
    const iterator =
      rec.iterator ??
      deps.executor.run(
        {
          taskId: rec.view.id,
          contextId: rec.view.contextId,
          prompt: rec.prompt,
          originOrcaNode: rec.origin_orca_node,
          ...(deps.selfOrcaNodeId ? { selfOrcaNodeId: deps.selfOrcaNodeId } : {}),
          ...(deps.workspace ? { workspaceDir: deps.workspace.work, podDir: deps.workspace.pod } : {}),
          metadata: rec.metadata,
        },
        rec.abort.signal,
      );
    rec.iterator = iterator;
    rec.view.status = { state: "working", timestamp: nowIso() };
    persist(rec);
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
          return;
        }
        if (event.type === "artifact") {
          const blob = deps.blobs.put(Buffer.from(event.content, "utf8"), { name: event.name });
          rec.view.artifacts = [
            ...(rec.view.artifacts ?? []),
            { artifactId: blob.blob_id, name: event.name, mediaType: "text/plain", bytes: blob.size },
          ];
          persist(rec);
        } else if (event.type === "completed") {
          finish(rec, "completed", textMessage(event.text));
          return;
        } else if (event.type === "failed") {
          finish(rec, "failed", textMessage(event.text));
          return;
        }
        step = await iterator.next();
      }
      finish(rec, "failed", textMessage("executor exited without a terminal event"), "executor_exited");
    } catch (error) {
      if (rec.abort.signal.aborted) {
        finish(rec, "canceled", undefined, rec.view.status.reason ?? "canceled");
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      finish(rec, "failed", textMessage(reason), "executor_error");
    }
  }

  function submit(input: SubmitTaskInput): TaskView {
    if (activeTaskId !== null) throw new TaskError("orca_node_busy", "orca node is busy with another task");
    validatePodMetadata(input.metadata, selfOrcaNodeId, deps.maxHop ?? 0);
    try {
      echoScriptFrom(input.metadata); // validate before a task exists (§6.3)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskError("bad_echo_script", message);
    }
    const id = newTaskId();
    const contextId = input.message.contextId ?? id;
    const createdAt = nowIso();
    const ttlS = Number(input.metadata?.["pod"] && (input.metadata["pod"] as { task_ttl_s?: number }).task_ttl_s) || defaultTtlS;
    const rec: Running = {
      view: {
        kind: "task",
        id,
        contextId,
        status: { state: "submitted", timestamp: createdAt },
        metadata: input.metadata ?? {},
      },
      metadata: input.metadata,
      origin_orca_node: input.originOrcaNode ?? "unknown",
      prompt: messageText(input.message),
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
    };
    activeTaskId = id;
    tasks.set(id, rec);
    persist(rec);
    armTtl(rec);
    void pump(rec);
    return cloneView(rec.view);
  }

  function get(taskId: string): TaskView | null {
    const rec = tasks.get(taskId);
    if (rec) return cloneView(rec.view);
    const stored = store.load(taskId);
    return stored ? cloneView(stored.view) : null;
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
      void escalationThenContinue(rec, escalation, grant);
      return cloneView(rec.view);
    }
    activeTaskId = taskId;
    const relay = rec.relay;
    rec.relay = null;
    if (relay !== null && grant !== undefined) {
      rec.view.status = { state: "working", timestamp: nowIso() };
      persist(rec);
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

  return { submit, get, resume, escalate, cancel, busy, recover };
}
