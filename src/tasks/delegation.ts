import { randomUUID } from "node:crypto";

import { deriveChildGrant } from "../security/grants.ts";
import { signGrant } from "../security/crypto.ts";
import type { DispatchEntry, DispatchStore } from "../storage/stores.ts";
import { PodError } from "../kernel/errors.ts";

import type { NodeIdentity } from "../security/identity.ts";
import type { Membership } from "../membership/membership.ts";
import {
  controlMessage,
  isTerminal,
  permissionRequestOf,
  type PodTaskMetadata,
  type SubmitTaskInput,
  type TaskRunner,
  type TaskView,
} from "../protocol/task.ts";
import type { A2AMethod, A2AParams } from "../protocol/a2a.ts";
import type { Grant, GrantMode, PermissionRequest, ResumeControl, SignedGrant, TaskRelay } from "../protocol/grant.ts";
import type { PeerClient } from "../protocol/client.ts";
import type { PodEventInput } from "../protocol/events.ts";
import type { OrcaNodeId, WorkgroupId } from "../protocol/peer.ts";

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
  workgroupId: WorkgroupId;
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

/** Options of a dispatch: the local task whose agent is sending, and the usual call options. */
export type SendTaskOptions = TaskCallOptions & {
  /** A task an agent creates while running this local task inherits its chain (§5.1). */
  parentTaskId?: string;
};

export type Delegation = {
  /**
   * Dispatch a task to a known member. A stranger is not joined implicitly: the
   * URL would receive the admission proof just because a tool call named it.
   * Add a member with `join` (the plugin's `connect`, the CLI's `serve --peer`) first.
   */
  sendTask(peerUrl: string, input: SubmitTaskInput, options?: SendTaskOptions): Promise<TaskView>;
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

/**
 * Metadata a child task inherits from the task whose agent created it (§5.1).
 * The gateway is the only place that increments the hop and appends the chain;
 * agents cannot write these fields themselves.
 */
export function childPodMetadata(
  parent: PodTaskMetadata | undefined,
  parentTaskId: string,
  selfOrcaNodeId: OrcaNodeId,
): PodTaskMetadata {
  return {
    hop: (parent?.hop ?? 0) + 1,
    chain: [...(parent?.chain ?? []), selfOrcaNodeId],
    root: parent?.root ?? parentTaskId,
    ...(parent?.root_origin !== undefined ? { root_origin: parent.root_origin } : {}),
    ...(parent?.permission_mode !== undefined ? { permission_mode: parent.permission_mode } : {}),
  };
}

/**
 * Origin-side dispatch log (§8.3).
 *
 * A task belongs to the node that created it (`origin_orca_node`), and the target
 * keeps the durable record. The origin keeps its own small log of "what did I hand
 * to whom, and what did I last hear": after an origin restart the tasks it
 * dispatched are still running on other machines, and the origin must be able to
 * tell what it knows and what it no longer knows.
 *
 * The rule from §8.3: never turn "I cannot see it" into "it failed". Entries that
 * were still in flight when the process restarted are marked `unknown`, not failed;
 * polling a recovered entry replaces that with the real state again.
 *
 * On startup, mark every non-terminal entry `unknown` — the origin cannot know
 * what the remote task did while the origin was down. Returns the count.
 */
export function markInFlightUnknown(store: Pick<DispatchStore, "list" | "save">): number {
  let count = 0;
  for (const entry of store.list()) {
    if (isTerminal(entry.state)) continue;
    store.save({ ...entry, state: "unknown", last_error: "origin_restart", updated_at: new Date().toISOString() });
    count += 1;
  }
  return count;
}

/** Grant validity is deliberately short: it only has to cover one resume. */
const GRANT_TTL_S = 300;
const CHILD_LINK_INTERVAL_MS = 1000;
const CHILD_LINK_MAX_FAILURES = 10;

/** The abort signal is only passed along when the caller gave one. */
function callOptions(options: TaskCallOptions): TaskCallOptions {
  return options.signal === undefined ? {} : { signal: options.signal };
}

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
    // The receiving gateway validates the chain and rejects callbacks to ancestors;
    // the origin-signed grant is matched against it when a request is escalated (§7.12).
    const pod = { ...input.metadata?.pod, ...childPodMetadata(parent.metadata?.pod, parentTaskId, selfId) };
    return { ...input, metadata: { ...input.metadata, pod } };
  }

  async function sendTask(peerUrl: string, input: SubmitTaskInput, options: SendTaskOptions = {}): Promise<TaskView> {
    const peerId = client.known(peerUrl);
    const state = peerId === selfId ? "online" : (deps.membership.get(peerId)?.state ?? "gone");
    if (state !== "online") throw new PodError("peer_not_online", `peer ${peerId} is ${state}`);
    const body = options.parentTaskId === undefined ? input : withParentChain(input, options.parentTaskId);
    const view = await client.rpc(peerUrl, "message/send", body, callOptions(options));
    recordDispatch(peerUrl, view);
    return view;
  }

  /** One read or control call on a task; the answer refreshes the dispatch log. */
  async function taskCall<M extends A2AMethod>(
    peerUrl: string,
    method: M,
    params: A2AParams<M>,
    options: TaskCallOptions = {},
  ): Promise<TaskView> {
    const view = await client.rpc(peerUrl, method, params, callOptions(options));
    refreshDispatch(view);
    return view;
  }

  const getTask = (peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView> =>
    taskCall(peerUrl, "tasks/get", { id: taskId }, options);
  const cancelTask = (peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView> =>
    taskCall(peerUrl, "tasks/cancel", { id: taskId }, options);
  const escalateTask = (peerUrl: string, taskId: string, relay: TaskRelay): Promise<TaskView> =>
    taskCall(peerUrl, "tasks/escalate", { taskId, relay });

  /** Answer a suspended task with a grant or a denial. */
  function resume(peerUrl: string, view: TaskView, control: ResumeControl): Promise<TaskView> {
    return taskCall(peerUrl, "message/send", { message: controlMessage(view.id, control, randomUUID()) });
  }

  async function approveTask(peerUrl: string, view: TaskView, options: ApprovalOptions = {}): Promise<TaskView> {
    const request = permissionRequestOf(view);
    if (request === null) throw new Error("task is not waiting for a permission decision");
    // Chained approval forwards the grant this node holds for the task that is delegating (§7.12).
    const grant =
      options.parentGrant === undefined
        ? signTopLevelGrant(view.id, request, options)
        : deriveChildGrant({ parent: options.parentGrant, request, selfOrcaNodeId: selfId });
    return resume(peerUrl, view, { grant });
  }

  /** This node is the origin: sign a fresh grant for the request (§7.11). */
  function signTopLevelGrant(taskId: string, request: PermissionRequest, options: ApprovalOptions): SignedGrant {
    const issuedAt = Date.now();
    const unsigned: Grant = {
      grant_id: randomUUID(),
      workgroup_id: deps.workgroupId,
      origin_orca_node: selfId,
      task_id: taskId,
      target_orca_node: request.requested_by,
      tool: request.tool,
      mode: options.mode ?? "allow_once",
      chain: [selfId, ...request.via],
      request_id: request.origin_request_id ?? request.request_id,
      issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(issuedAt + (options.ttlS ?? GRANT_TTL_S) * 1000).toISOString(),
    };
    return signGrant(deps.identity, unsigned);
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
      if ((await watchChild(childTaskId, link)) === "drop") childLinks.delete(childTaskId);
    }
    if (childLinks.size > 0) scheduleTick();
  }

  /** One look at a child: keep watching it, or drop the link because nothing is left to relay. */
  async function watchChild(childTaskId: string, link: ChildLink): Promise<"keep" | "drop"> {
    const parent = tasks.get(link.parentTaskId);
    if (parent === null || isTerminal(parent.status.state)) return "drop";
    // Already parked on a permission request: wait for the origin's decision.
    if (parent.status.state !== "working") return "keep";
    let child: TaskView;
    try {
      child = await getTask(link.peer, childTaskId);
    } catch {
      link.failures += 1;
      return link.failures >= CHILD_LINK_MAX_FAILURES ? "drop" : "keep";
    }
    link.failures = 0;
    if (isTerminal(child.status.state)) return "drop";
    const request = permissionRequestOf(child);
    if (request === null) return "keep";
    try {
      tasks.escalate(link.parentTaskId, { peer: link.peer, task_id: childTaskId, request });
    } catch (error) {
      // The parent moved on between the read and the call; stop watching.
      if (error instanceof PodError && error.code === "task_not_found") return "drop";
    }
    return "keep";
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
      markInFlightUnknown(dispatches);
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
