/**
 * What the Orca panel and its host half say to each other over `/orca-api`
 * (§9.2): request bodies as schemas the host parses, response shapes as types
 * the client imports (type-only, so they are erased from the bundle).
 */

import { z } from "zod";

import type { PanelPatch } from "../node/settings.ts";
import type { TaskView } from "../task/wire.ts";
import type { PodAdmin, PodTaskDetail, PodTaskRow } from "./admin.ts";

const Text = z.string().min(1, "must be a non-empty string");

/** `approve`, `cancel`: one task on one peer. */
export const PeerTaskBodySchema = z.object({ peer: Text, task_id: Text });
export type PeerTaskBody = z.infer<typeof PeerTaskBodySchema>;

/** `deny`: the same, and why. A reason that is not text is dropped, not an error. */
export const DenyBodySchema = PeerTaskBodySchema.extend({ reason: z.string().optional().catch(undefined) });
export type DenyBody = z.infer<typeof DenyBodySchema>;

/** `connect`: the peer address to join. */
export const ConnectBodySchema = z.object({ peer: Text });
export type ConnectBody = z.infer<typeof ConnectBodySchema>;

/** What each POST action of the panel takes; `disconnect` and `reset` read no body. */
export type PodActions = {
  config: PanelPatch;
  connect: ConnectBody;
  disconnect: Record<string, never>;
  reset: Record<string, never>;
  approve: PeerTaskBody;
  deny: DenyBody;
  cancel: PeerTaskBody;
};

/** Panel state snapshot: everything the status page and the approval cards render in one poll. */
export interface PodState {
  self: ReturnType<PodAdmin["self"]>;
  config: ReturnType<PodAdmin["config"]>;
  members: ReturnType<PodAdmin["members"]>;
  mesh: { reachable: number };
  approvals: ReturnType<PodAdmin["approvals"]>;
  approval_count: number;
  recent: ReturnType<PodAdmin["recent"]>;
  workspace: ReturnType<PodAdmin["workspace"]>;
}

/** `GET /orca-api/tasks`: every task this node knows about, for the "all tasks" view. */
export type PodTasksResponse = { recent: PodTaskRow[] };

/** The GET routes: the query string each reads and the body it answers with. */
export type PodReads = {
  state: { query: Record<string, never>; response: PodState };
  tasks: { query: { limit?: number }; response: PodTasksResponse };
  task: { query: { peer: string; task: string }; response: PodTaskDetail };
};

/** What `approve`, `deny` and `cancel` answer with: the task as its peer reports it now. */
export type PodTaskResponse = { task: TaskView };
