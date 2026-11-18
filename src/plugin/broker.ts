/**
 * The one approval path for remote permission requests.
 *
 * A task this node dispatched can suspend on a permission request. The tracker
 * observes it and parks it here; the Orca Pod UI (chat card, popup, panel) is the
 * only channel that answers it, because granting authority belongs to the user,
 * never to a model. The broker also executes the decision on the remote task and
 * drops the prompt when the task settles.
 */

import { randomUUID } from "node:crypto";

import type { OrcaNode } from "../node/orca-node.ts";
import type { PermissionRequest } from "../core/wire/grant.ts";
import type { TaskView } from "../task/wire.ts";

/** One approval the UI may answer; `agent_id` is the session that dispatched the task. */
interface ApprovalPrompt {
  id: string;
  peer: string;
  task_id: string;
  request_id: string;
  tool: string;
  requested: unknown;
  /** Full request, so the UI can show who asks and the request it previews. */
  request: PermissionRequest;
  agent_id: string;
  created_at: string;
}

/** The two orca-node calls that carry a decision to the remote task. */
export type BrokerNode = Pick<OrcaNode, "approveTask" | "denyTask">;

export interface ApprovalBroker {
  /**
   * Park a request seen on a tracked task. The tracker polls while the task stays
   * suspended, so the same request id keeps its prompt (stable id and created_at).
   */
  park(input: { peer: string; view: TaskView; request: PermissionRequest; agentId: string }): void;
  /** Pending prompts, oldest first. */
  list(): ApprovalPrompt[];
  /** Grant the parked request once; resolves with the resumed task. */
  approve(peer: string, taskId: string): Promise<TaskView>;
  /** Fail the parked request on the remote task. */
  deny(peer: string, taskId: string, reason?: string): Promise<TaskView>;
  /** Drop the prompt of a task that settled or was answered elsewhere. */
  withdraw(peer: string, taskId: string): void;
  /** Drop every prompt (plugin unload). */
  clear(): void;
  subscribe(listener: () => void): () => void;
}

interface Parked {
  prompt: ApprovalPrompt;
  /** The view the user saw; the grant is signed for exactly its request. */
  view: TaskView;
}

/** The key a task is known by on this side: where it runs and its id there. Stable across polls. */
export const taskKey = (peer: string, taskId: string): string => `${peer}|${taskId}`;

export function createApprovalBroker(getNode: () => BrokerNode | null): ApprovalBroker {
  const parked = new Map<string, Parked>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  /** Run one decision against the remote task, then drop the prompt it answered. */
  async function decide(
    peer: string,
    taskId: string,
    act: (node: BrokerNode, view: TaskView) => Promise<TaskView>,
  ): Promise<TaskView> {
    const node = getNode();
    if (node === null) throw new Error("orca node is not running");
    const key = taskKey(peer, taskId);
    const entry = parked.get(key);
    if (entry === undefined) throw new Error("task has no pending permission request");
    const resumed = await act(node, entry.view);
    // A failed call leaves the prompt for a retry; a newer request keeps its own.
    if (parked.get(key) === entry) {
      parked.delete(key);
      notify();
    }
    return resumed;
  }

  return {
    park({ peer, view, request, agentId }) {
      const key = taskKey(peer, view.id);
      if (parked.get(key)?.prompt.request_id === request.request_id) return;
      const prompt: ApprovalPrompt = {
        id: randomUUID(),
        peer,
        task_id: view.id,
        request_id: request.request_id,
        tool: request.tool,
        requested: request.requested,
        request,
        agent_id: agentId,
        created_at: new Date().toISOString(),
      };
      parked.set(key, { prompt, view });
      notify();
    },
    list: () => [...parked.values()].map((entry) => entry.prompt),
    approve: (peer, taskId) => decide(peer, taskId, (node, view) => node.approveTask(peer, view)),
    deny: (peer, taskId, reason = "denied from the UI") =>
      decide(peer, taskId, (node, view) => node.denyTask(peer, view, reason)),
    withdraw(peer, taskId) {
      if (parked.delete(taskKey(peer, taskId))) notify();
    },
    clear() {
      if (parked.size === 0) return;
      parked.clear();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
