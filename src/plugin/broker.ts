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
import type { Pod } from "./pod.ts";

/** One approval the UI may answer; `agent_id` is the session that dispatched the task. */
export interface ApprovalPrompt {
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

interface Parked {
  prompt: ApprovalPrompt;
  /** The view the user saw; the grant is signed for exactly its request. */
  view: TaskView;
}

/** The key a task is known by on this side: where it runs and its id there. Stable across polls. */
export const taskKey = (peer: string, taskId: string): string => `${peer}|${taskId}`;

export class ApprovalBroker {
  private readonly parked = new Map<string, Parked>();

  /** The pod owns the running node, which carries a decision to the remote task. */
  constructor(private readonly pod: Pod) {}

  /**
   * Park a request seen on a tracked task. The tracker polls while the task stays
   * suspended, so the same request id keeps its prompt (stable id and created_at).
   */
  park({
    peer,
    view,
    request,
    agentId,
  }: {
    peer: string;
    view: TaskView;
    request: PermissionRequest;
    agentId: string;
  }): void {
    const key = taskKey(peer, view.id);
    if (this.parked.get(key)?.prompt.request_id === request.request_id) return;
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
    this.parked.set(key, { prompt, view });
  }

  /** Pending prompts, oldest first. */
  list(): ApprovalPrompt[] {
    return [...this.parked.values()].map((entry) => entry.prompt);
  }

  /** Grant the parked request once; resolves with the resumed task. */
  approve(peer: string, taskId: string): Promise<TaskView> {
    return this.decide(peer, taskId, (node, view) => node.delegation.approveTask(peer, view));
  }

  /** Fail the parked request on the remote task. */
  deny(peer: string, taskId: string, reason = "denied from the UI"): Promise<TaskView> {
    return this.decide(peer, taskId, (node, view) => node.delegation.denyTask(peer, view, reason));
  }

  /** Drop the prompt of a task that settled or was answered elsewhere. */
  withdraw(peer: string, taskId: string): void {
    this.parked.delete(taskKey(peer, taskId));
  }

  /** Drop every prompt (plugin unload). */
  clear(): void {
    this.parked.clear();
  }

  /** Run one decision against the remote task, then drop the prompt it answered. */
  private async decide(
    peer: string,
    taskId: string,
    act: (node: OrcaNode, view: TaskView) => Promise<TaskView>,
  ): Promise<TaskView> {
    await this.pod.settled();
    const { node } = this.pod.requireRun();
    const key = taskKey(peer, taskId);
    const entry = this.parked.get(key);
    if (entry === undefined) throw new Error("task has no pending permission request");
    const resumed = await act(node, entry.view);
    // A failed call leaves the prompt for a retry; a newer request keeps its own.
    if (this.parked.get(key) === entry) this.parked.delete(key);
    return resumed;
  }
}
