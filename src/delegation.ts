import { randomUUID } from "node:crypto";

import { childPodMetadata, deriveChildGrant } from "./chain.ts";
import { signGrant } from "./crypto.ts";
import type { DispatchEntry, DispatchStore } from "./dispatches.ts";
import { PodError } from "./errors.ts";
import type { PodEventInput } from "./events.ts";
import type { NodeIdentity } from "./identity.ts";
import type { Membership } from "./membership.ts";
import type { PeerClient } from "./peer_client.ts";
import {
  isTerminal,
  permissionRequestOf,
  type A2AMessage,
  type Grant,
  type GrantMode,
  type PodTaskMetadata,
  type SignedGrant,
  type SubmitTaskInput,
  type TaskRelay,
  type TaskRunner,
  type TaskView,
} from "./protocol.ts";

export interface ApprovalOptions {
  mode?: GrantMode;
  /** How long the signed grant stays valid, default 300s. */
  ttlS?: number;
  /**
   * Grant this orca node holds for the task currently asking to delegate.
   * When set, approveTask derives a child grant from it instead of signing a
   * fresh top-level grant (§7.12).
   */
  parentGrant?: SignedGrant;
}

type DelegationDeps = {
  identity: NodeIdentity;
  workgroupId: string;
  client: PeerClient;
  membership: Membership;
  /** Local tasks: a delegating task is the parent of what it sends, and gets parked on escalation. */
  tasks: Pick<TaskRunner, "get" | "escalate">;
  /** Origin-side log of what this node handed to peers, so a restart does not lose track (§8.3). */
  dispatches: DispatchStore;
  emit: (event: PodEventInput) => void;
};

/** Per-call options of a task read or control call. */
export type TaskCallOptions = {
  /** Aborts the outbound request (for example when the caller's turn is cancelled). */
  signal?: AbortSignal;
};

export type Delegation = {
  /**
   * Dispatch a task to a known member. A stranger is not joined implicitly: the
   * URL would receive the admission proof just because a tool call named it.
   * Add a member with `join` (the plugin's `connect`, the CLI's `serve --peer`) first.
   */
  sendTask(
    peerUrl: string,
    input: SubmitTaskInput,
    options?: { parentTaskId?: string; signal?: AbortSignal },
  ): Promise<TaskView>;
  getTask(peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView>;
  cancelTask(peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView>;
  /** Sign a grant for the suspended permission request and resume the task (§7.11). */
  approveTask(peerUrl: string, view: TaskView, options?: ApprovalOptions): Promise<TaskView>;
  denyTask(peerUrl: string, view: TaskView, reason?: string): Promise<TaskView>;
  /** Park a local task because a child it delegated to needs a permission only the origin can grant (§7.12). */
  escalateTask(peerUrl: string, taskId: string, relay: TaskRelay): Promise<TaskView>;
  /** Watch a child task of a local task and park the local task when the child asks for a permission (§7.12). */
  linkChildTask(parentTaskId: string, peerUrl: string, childTaskId: string): void;
  listDispatches(): DispatchEntry[];
  /** Stamp the DSH session that dispatched a task, so tracking can resume after a restart (§8.3). */
  annotateDispatch(taskId: string, agentId: string): void;
  start(): void;
  stop(): void;
};

/** Grant validity is deliberately short: it only has to cover one resume. */
const GRANT_TTL_S = 300;
const CHILD_LINK_INTERVAL_MS = 1000;
const CHILD_LINK_MAX_FAILURES = 10;

type ChildLink = { parentTaskId: string; peer: string; failures: number };

export function createDelegation(deps: DelegationDeps): Delegation {
  const { client, dispatches, tasks } = deps;
  const selfId = deps.identity.orcaNodeId;

  // ---- dispatch log (§8.3) ----

  function saveDispatch(entry: DispatchEntry): void {
    dispatches.save(entry);
    deps.emit({ type: "dispatch", entry });
  }

  /** Only `sendTask` means "this origin dispatched it": reads must never create entries. */
  function recordDispatch(peerUrl: string, view: TaskView): void {
    const previous = dispatches.get(view.id);
    const now = new Date().toISOString();
    saveDispatch({
      ...previous,
      task_id: view.id,
      peer: peerUrl,
      context_id: view.contextId,
      state: view.status.state,
      last_error: view.status.reason,
      created_at: previous?.created_at ?? now,
      updated_at: now,
    });
  }

  /** Follow an existing entry after a read; the tracker and the panel read constantly. */
  function refreshDispatch(view: TaskView): void {
    const previous = dispatches.get(view.id);
    if (previous === undefined) return;
    if (previous.state === view.status.state && previous.last_error === view.status.reason) return;
    saveDispatch({
      ...previous,
      state: view.status.state,
      last_error: view.status.reason,
      updated_at: new Date().toISOString(),
    });
  }

  // ---- outbound task calls ----

  /** A task an agent creates while running another one inherits the parent's chain (§5.1). */
  function withParentChain(input: SubmitTaskInput, parentTaskId: string): SubmitTaskInput {
    const parent = tasks.get(parentTaskId);
    if (parent === null) throw new Error(`unknown local task ${parentTaskId}`);
    const parentPod = parent.metadata?.pod as PodTaskMetadata | undefined;
    const callerPod = input.metadata?.pod as Record<string, unknown> | undefined;
    // The receiving gateway validates the chain and rejects callbacks to ancestors;
    // the origin-signed grant is matched against it when a request is escalated (§7.12).
    const pod = { ...callerPod, ...childPodMetadata(parentPod, parentTaskId, selfId) };
    return { ...input, metadata: { ...input.metadata, pod } };
  }

  async function sendTask(
    peerUrl: string,
    input: SubmitTaskInput,
    options: { parentTaskId?: string; signal?: AbortSignal } = {},
  ) {
    const peerId = client.known(peerUrl);
    const state = peerId === selfId ? "online" : (deps.membership.get(peerId)?.state ?? "gone");
    if (state !== "online") throw new PodError("peer_not_online", `peer ${peerId} is ${state}`);
    const body = options.parentTaskId === undefined ? input : withParentChain(input, options.parentTaskId);
    const view = await client.rpc<TaskView>(
      peerUrl,
      "message/send",
      body,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    recordDispatch(peerUrl, view);
    return view;
  }

  /** One read or control call on a task; the answer refreshes the dispatch log. */
  async function taskCall(
    peerUrl: string,
    method: string,
    params: unknown,
    options: TaskCallOptions = {},
  ): Promise<TaskView> {
    const view = await client.rpc<TaskView>(
      peerUrl,
      method,
      params,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    refreshDispatch(view);
    return view;
  }

  const getTask = (peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView> =>
    taskCall(peerUrl, "tasks/get", { id: taskId }, options);
  const cancelTask = (peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView> =>
    taskCall(peerUrl, "tasks/cancel", { id: taskId }, options);
  const escalateTask = (peerUrl: string, taskId: string, relay: TaskRelay): Promise<TaskView> =>
    taskCall(peerUrl, "tasks/escalate", { taskId, relay });

  /** A control message answering a suspended task: data parts only, addressed by task id. */
  function resume(peerUrl: string, view: TaskView, data: Record<string, unknown>): Promise<TaskView> {
    const message: A2AMessage = {
      role: "user",
      parts: [{ kind: "data", data }],
      taskId: view.id,
      messageId: randomUUID(),
    };
    return taskCall(peerUrl, "message/send", { message });
  }

  async function approveTask(peerUrl: string, view: TaskView, options: ApprovalOptions = {}): Promise<TaskView> {
    const request = permissionRequestOf(view);
    if (request === null) throw new Error("task is not waiting for a permission decision");
    let grant: SignedGrant;
    if (options.parentGrant !== undefined) {
      // Chained approval: forward the grant this node holds for the task that is delegating (§7.12).
      grant = deriveChildGrant({ parent: options.parentGrant, request, selfOrcaNodeId: selfId });
    } else {
      const issuedAt = Date.now();
      const unsigned: Grant = {
        grant_id: randomUUID(),
        workgroup_id: deps.workgroupId,
        origin_orca_node: selfId,
        task_id: view.id,
        target_orca_node: request.requested_by,
        tool: request.tool,
        mode: options.mode ?? "allow_once",
        chain: [selfId, ...request.via],
        request_id: request.origin_request_id ?? request.request_id,
        issued_at: new Date(issuedAt).toISOString(),
        expires_at: new Date(issuedAt + (options.ttlS ?? GRANT_TTL_S) * 1000).toISOString(),
      };
      grant = signGrant(deps.identity, unsigned);
    }
    return resume(peerUrl, view, { grant });
  }

  const denyTask = (peerUrl: string, view: TaskView, reason = "denied by origin"): Promise<TaskView> =>
    resume(peerUrl, view, { permission_denied: true, reason });

  // ---- child links (§7.12) ----

  /** Tasks a local task delegated, keyed by child task id, watched for permission requests. */
  const childLinks = new Map<string, ChildLink>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  function scheduleTick(delayMs = CHILD_LINK_INTERVAL_MS): void {
    if (!running || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
    timer.unref();
  }

  /**
   * Automatic chain ascent: poll each child this node dispatched; when one asks
   * for a permission, park the local task that delegated to it, so the origin
   * approves once and the grant flows back down. The executor never has to call
   * `escalate` itself.
   */
  async function tick(): Promise<void> {
    for (const [childTaskId, link] of [...childLinks]) {
      if (!running) return;
      const parent = tasks.get(link.parentTaskId);
      if (parent === null || isTerminal(parent.status.state)) {
        childLinks.delete(childTaskId);
        continue;
      }
      // Already parked on a permission request: wait for the origin's decision.
      if (parent.status.state !== "working") continue;
      let child: TaskView;
      try {
        child = await getTask(link.peer, childTaskId);
      } catch {
        link.failures += 1;
        if (link.failures >= CHILD_LINK_MAX_FAILURES) childLinks.delete(childTaskId);
        continue;
      }
      link.failures = 0;
      if (isTerminal(child.status.state)) {
        childLinks.delete(childTaskId);
        continue;
      }
      const request = permissionRequestOf(child);
      if (request === null) continue;
      try {
        tasks.escalate(link.parentTaskId, { peer: link.peer, task_id: childTaskId, request });
      } catch (error) {
        // The parent moved on between the read and the call; stop watching.
        if (error instanceof PodError && error.code === "task_not_found") childLinks.delete(childTaskId);
      }
    }
    if (childLinks.size > 0) scheduleTick();
  }

  function linkChildTask(parentTaskId: string, peerUrl: string, childTaskId: string): void {
    const parent = tasks.get(parentTaskId);
    if (parent === null) throw new PodError("bad_request", `unknown local task ${parentTaskId}`);
    if (isTerminal(parent.status.state)) {
      throw new PodError("bad_request", `local task ${parentTaskId} is already ${parent.status.state}`);
    }
    childLinks.set(childTaskId, { parentTaskId, peer: peerUrl, failures: 0 });
    const entry = dispatches.get(childTaskId);
    if (entry !== undefined && entry.parent_local_task_id !== parentTaskId) {
      saveDispatch({ ...entry, parent_local_task_id: parentTaskId, updated_at: new Date().toISOString() });
    }
    scheduleTick(0);
  }

  return {
    sendTask,
    getTask,
    cancelTask,
    approveTask,
    denyTask,
    escalateTask,
    linkChildTask,
    listDispatches: () => dispatches.list(),
    annotateDispatch(taskId, agentId) {
      const entry = dispatches.get(taskId);
      if (entry !== undefined && entry.agent_id !== agentId) saveDispatch({ ...entry, agent_id: agentId });
    },
    start() {
      // A restart means this node no longer knows what its in-flight dispatches did (§8.3).
      dispatches.markUnknown();
      running = true;
    },
    stop() {
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      childLinks.clear();
    },
  };
}
