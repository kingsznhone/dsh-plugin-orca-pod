import { randomUUID } from "node:crypto";

import { z } from "zod";

import { PodError } from "../core/errors.ts";
import { EventBus, type NodeLogger } from "../core/events.ts";
import type { NodeIdentity } from "../core/identity.ts";
import { describeIssue, parseSchema } from "../core/schema.ts";
import type { Grant, ResumeControl } from "../core/wire/grant.ts";
import type { WorkgroupId } from "../core/wire/peer.ts";
import { ErrorReplySchema } from "../core/wire/reply.ts";
import type { Membership } from "../mesh/membership.ts";
import { remoteError, type CallOptions, type HttpPeerClient } from "../mesh/peer-client.ts";
import type { DispatchStore } from "./dispatch-store.ts";
import { DispatchLog } from "./dispatch-log.ts";
import { signGrant } from "./grants.ts";
import {
  RpcResultSchema,
  controlMessage,
  permissionRequestOf,
  type A2AMethod,
  type A2AParams,
  type DispatchEvent,
  type SubmitTaskInput,
  type TaskView,
} from "./wire.ts";

/** What a delegation is told besides its collaborators. */
export type DelegationOptions = {
  workgroupId: WorkgroupId;
  /** Hears about a subscriber that threw while being told of a dispatch change. */
  logger?: NodeLogger;
};

/** Grant validity is deliberately short: it only has to cover one resume. */
const GRANT_TTL_S = 300;

/**
 * Signed JSON-RPC call to a peer's `/a2a` (§4.7); every method answers with a
 * task view. A peer may also answer 200 with an error envelope, which is an error too.
 * The CLI makes the same call without a running node, so this is a function and
 * not a method.
 */
export async function rpc<M extends A2AMethod>(
  client: HttpPeerClient,
  endpoint: string,
  method: M,
  params: A2AParams<M>,
  options: CallOptions = {},
): Promise<TaskView> {
  const json = await client.call(
    endpoint,
    {
      method: "POST",
      path: "/a2a",
      label: method,
      payload: { jsonrpc: "2.0", id: randomUUID(), method, params },
      reply: z.unknown(),
    },
    options,
  );
  const envelope = ErrorReplySchema.safeParse(json);
  if (envelope.success && envelope.data.error !== undefined) throw remoteError(method, 200, envelope.data);
  const parsed = parseSchema(RpcResultSchema, json);
  if (!parsed.ok) {
    throw new PodError("peer_error", `${method} 200: unexpected reply: ${describeIssue(parsed.issue)}`, 502);
  }
  return parsed.value.result;
}

/**
 * Outbound task calls (§4.7): hand a task to a member, read it, cancel it, and
 * answer its permission request as the origin (§7.11). Every answer is written
 * to the dispatch log.
 */
export class Delegation {
  /** Fires when a dispatch-log entry changed (§9.2). */
  readonly events: EventBus<DispatchEvent>;
  /** What this node handed to peers, so a restart does not lose track (§8.3). */
  readonly log: DispatchLog;
  private readonly workgroupId: WorkgroupId;

  constructor(
    private readonly identity: NodeIdentity,
    private readonly client: HttpPeerClient,
    private readonly membership: Membership,
    dispatches: DispatchStore,
    options: DelegationOptions,
  ) {
    this.workgroupId = options.workgroupId;
    this.events = new EventBus(options.logger);
    this.log = new DispatchLog(dispatches, this.events);
  }

  /** A restart means this node no longer knows what its in-flight dispatches did (§8.3). */
  start(): void {
    this.log.markInFlightUnknown();
  }

  /**
   * Dispatch a task to a known member. A stranger is not joined implicitly: the
   * URL would receive the admission proof just because a tool call named it.
   * Add a member with `join` (the plugin's `connect`, the CLI's `serve --peer`) first.
   */
  async sendTask(peerUrl: string, input: SubmitTaskInput, signal?: AbortSignal): Promise<TaskView> {
    const peerId = this.client.known(peerUrl);
    const state = peerId === this.identity.orcaNodeId ? "online" : (this.membership.get(peerId)?.state ?? "gone");
    if (state !== "online") throw new PodError("peer_not_online", `peer ${peerId} is ${state}`);
    const view = await rpc(this.client, peerUrl, "message/send", input, { signal });
    this.log.recordSend(peerUrl, view);
    return view;
  }

  getTask(peerUrl: string, taskId: string, signal?: AbortSignal): Promise<TaskView> {
    return this.taskCall(peerUrl, "tasks/get", { id: taskId }, signal);
  }

  cancelTask(peerUrl: string, taskId: string, signal?: AbortSignal): Promise<TaskView> {
    return this.taskCall(peerUrl, "tasks/cancel", { id: taskId }, signal);
  }

  /** This node is the origin: sign a grant for the request the task is parked on and resume it (§7.11). */
  async approveTask(peerUrl: string, view: TaskView): Promise<TaskView> {
    const request = permissionRequestOf(view);
    if (request === null) throw new Error("task is not waiting for a permission decision");
    const issuedAt = Date.now();
    const grant: Grant = {
      grant_id: randomUUID(),
      workgroup_id: this.workgroupId,
      origin_orca_node: this.identity.orcaNodeId,
      task_id: view.id,
      target_orca_node: request.requested_by,
      tool: request.tool,
      // The task asked for exactly this mode; it keeps it until it ends (§7.12).
      permission_mode: request.requested_mode,
      request_id: request.request_id,
      issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(issuedAt + GRANT_TTL_S * 1000).toISOString(),
    };
    return this.resume(peerUrl, view, { grant: signGrant(this.identity, grant) });
  }

  denyTask(peerUrl: string, view: TaskView, reason = "denied by origin"): Promise<TaskView> {
    return this.resume(peerUrl, view, { permission_denied: true, reason });
  }

  /** One read or control call on a task; the answer refreshes the dispatch log. */
  private async taskCall<M extends A2AMethod>(
    peerUrl: string,
    method: M,
    params: A2AParams<M>,
    signal?: AbortSignal,
  ): Promise<TaskView> {
    const view = await rpc(this.client, peerUrl, method, params, { signal });
    this.log.refresh(view);
    return view;
  }

  /** Answer a suspended task with a grant or a denial. */
  private resume(peerUrl: string, view: TaskView, control: ResumeControl): Promise<TaskView> {
    return this.taskCall(peerUrl, "message/send", { message: controlMessage(view.id, control, randomUUID()) });
  }
}
