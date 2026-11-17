import { randomUUID } from "node:crypto";

import { signGrant } from "../security/crypto.ts";
import type { DispatchStore } from "../storage/stores.ts";
import type { DispatchEntry } from "../protocol/dispatch.ts";
import { PodError } from "../kernel/errors.ts";

import type { NodeIdentity } from "../security/identity.ts";
import type { Membership } from "../membership/membership.ts";
import {
  controlMessage,
  isTerminal,
  permissionRequestOf,
  type SubmitTaskInput,
  type TaskView,
} from "../protocol/task.ts";
import type { A2AMethod, A2AParams } from "../protocol/a2a.ts";
import type { Grant, GrantMode, ResumeControl } from "../protocol/grant.ts";
import type { PeerClient } from "../protocol/client.ts";
import type { PodEventInput } from "../protocol/events.ts";
import type { WorkgroupId } from "../protocol/peer.ts";

export interface ApprovalOptions {
  mode?: GrantMode;
  /** How long the signed grant stays valid, default 300s. */
  ttlS?: number;
}

type DelegationDeps = {
  identity: NodeIdentity;
  workgroupId: WorkgroupId;
  client: PeerClient;
  membership: Membership;
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
  sendTask(peerUrl: string, input: SubmitTaskInput, options?: TaskCallOptions): Promise<TaskView>;
  getTask(peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView>;
  cancelTask(peerUrl: string, taskId: string, options?: TaskCallOptions): Promise<TaskView>;
  /** Sign a grant for the suspended permission request and resume the task (§7.11). */
  approveTask(peerUrl: string, view: TaskView, options?: ApprovalOptions): Promise<TaskView>;
  denyTask(peerUrl: string, view: TaskView, reason?: string): Promise<TaskView>;
  listDispatches(): DispatchEntry[];
  /** Stamp the DSH session that dispatched a task, so tracking can resume after a restart (§8.3). */
  annotateDispatch(taskId: string, agentId: string): void;
  /** A restart means this node no longer knows what its in-flight dispatches did (§8.3). */
  start(): void;
};

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

/** The abort signal is only passed along when the caller gave one. */
function callOptions(options: TaskCallOptions): TaskCallOptions {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export function createDelegation(deps: DelegationDeps): Delegation {
  const { client, dispatches } = deps;
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

  async function sendTask(peerUrl: string, input: SubmitTaskInput, options: TaskCallOptions = {}): Promise<TaskView> {
    const peerId = client.known(peerUrl);
    const state = peerId === selfId ? "online" : (deps.membership.get(peerId)?.state ?? "gone");
    if (state !== "online") throw new PodError("peer_not_online", `peer ${peerId} is ${state}`);
    const view = await client.rpc(peerUrl, "message/send", input, callOptions(options));
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

  /** Answer a suspended task with a grant or a denial. */
  function resume(peerUrl: string, view: TaskView, control: ResumeControl): Promise<TaskView> {
    return taskCall(peerUrl, "message/send", { message: controlMessage(view.id, control, randomUUID()) });
  }

  /** This node is the origin: sign a grant for the request the task is parked on and resume it (§7.11). */
  async function approveTask(peerUrl: string, view: TaskView, options: ApprovalOptions = {}): Promise<TaskView> {
    const request = permissionRequestOf(view);
    if (request === null) throw new Error("task is not waiting for a permission decision");
    const issuedAt = Date.now();
    const grant: Grant = {
      grant_id: randomUUID(),
      workgroup_id: deps.workgroupId,
      origin_orca_node: selfId,
      task_id: view.id,
      target_orca_node: request.requested_by,
      tool: request.tool,
      mode: options.mode ?? "allow_once",
      request_id: request.request_id,
      issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(issuedAt + (options.ttlS ?? GRANT_TTL_S) * 1000).toISOString(),
    };
    return resume(peerUrl, view, { grant: signGrant(deps.identity, grant) });
  }

  const denyTask = (peerUrl: string, view: TaskView, reason = "denied by origin"): Promise<TaskView> =>
    resume(peerUrl, view, { permission_denied: true, reason });

  return {
    sendTask,
    getTask,
    cancelTask,
    approveTask,
    denyTask,
    listDispatches: () => dispatches.list(),
    annotateDispatch(taskId, agentId) {
      const entry = dispatches.get(taskId);
      if (entry !== undefined && entry.agent_id !== agentId) saveDispatch({ ...entry, agent_id: agentId });
    },
    start() {
      markInFlightUnknown(dispatches);
    },
  };
}
