/**
 * The one approval path for remote permission requests.
 *
 * A task this node dispatched can suspend on a permission request. The tracker
 * observes it and parks it here; the Orca Pod UI (chat card, popup, panel) is the
 * only channel that answers it, because granting authority belongs to the user,
 * never to a model. The broker also executes the decision on the remote task and
 * drops the prompt when the task settles.
 */

import type { PermissionRequest } from "../core/wire/grant.ts";
import type { OrcaNodeId } from "../core/wire/peer.ts";
import type { OrcaNode } from "../mesh/orca-node.ts";
import type { TaskView } from "../task/wire.ts";
import type { Pod } from "./pod.ts";

/** One approval the UI may answer; `agent_id` is the session that dispatched the task, null for a send without one. */
interface ApprovalPrompt {
  /** The node the task runs on. */
  node: OrcaNodeId;
  task_id: string;
  /** What is asked, by whom, and what the UI previews. */
  request: PermissionRequest;
  agent_id: string | null;
}

interface Parked {
  prompt: ApprovalPrompt;
  /** The view the user saw; the grant is signed for exactly its request. */
  view: TaskView;
}

/** The key a task is known by on this side: the node it runs on and its id there. Stable across polls. */
export const taskKey = (node: OrcaNodeId, taskId: string): string => `${node}|${taskId}`;

export class ApprovalBroker {
  private readonly parked = new Map<string, Parked>();

  /** The pod owns the running node, which carries a decision to the remote task. */
  constructor(private readonly pod: Pod) {}

  /**
   * Park a request seen on a tracked task. The tracker polls while the task stays
   * suspended; the same request id keeps the prompt it has.
   */
  park({
    node,
    view,
    request,
    agentId,
  }: {
    node: OrcaNodeId;
    view: TaskView;
    request: PermissionRequest;
    agentId: string | null;
  }): void {
    const key = taskKey(node, view.id);
    if (this.parked.get(key)?.prompt.request.request_id === request.request_id) return;
    this.parked.set(key, { prompt: { node, task_id: view.id, request, agent_id: agentId }, view });
  }

  /** Pending prompts, oldest first. */
  list(): ApprovalPrompt[] {
    return [...this.parked.values()].map((entry) => entry.prompt);
  }

  /** Grant the parked request once; resolves with the resumed task. `ref` names the node: its id, display name or address. */
  approve(ref: string, taskId: string): Promise<TaskView> {
    return this.decide(ref, taskId, (node, view) => node.approve(view));
  }

  /** Fail the parked request on the remote task. */
  deny(ref: string, taskId: string, reason = "denied from the UI"): Promise<TaskView> {
    return this.decide(ref, taskId, (node, view) => node.deny(view, reason));
  }

  /** Drop the prompt of a task that settled or was answered elsewhere. */
  withdraw(node: OrcaNodeId, taskId: string): void {
    this.parked.delete(taskKey(node, taskId));
  }

  /** Drop every prompt (plugin unload). */
  clear(): void {
    this.parked.clear();
  }

  /** Run one decision against the remote task, then drop the prompt it answered. */
  private async decide(
    ref: string,
    taskId: string,
    act: (node: OrcaNode, view: TaskView) => Promise<TaskView>,
  ): Promise<TaskView> {
    const node = (await this.pod.orca()).mesh.resolve(ref);
    const key = taskKey(node.id, taskId);
    const entry = this.parked.get(key);
    if (entry === undefined) throw new Error("task has no pending permission request");
    const resumed = await act(node, entry.view);
    // A failed call leaves the prompt for a retry; a newer request keeps its own.
    if (this.parked.get(key) === entry) this.parked.delete(key);
    return resumed;
  }
}
