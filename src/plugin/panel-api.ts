/**
 * What the Orca panel and its host half say to each other over `/orca-api`
 * (§9.2), in one place: request bodies as schemas the host parses, response
 * shapes as types the client imports (type-only, so they are erased from the
 * bundle). `panel.ts` fills the shapes, `panel-routes.ts` serves them.
 */

import type { LlmReasoningEffortInfo } from "@deepseek-ai/dsh-llm";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { z } from "zod";

import type { PeerView, SelfRecord } from "../core/wire/peer.ts";
import type { PanelPatch, Settings } from "../node/settings.ts";
import type { DispatchEntry, TaskState, TaskView } from "../task/wire.ts";

/** A file a task's result names as `<orca node id>/<sha256>` (§5.6), which the panel saves through this node. */
export interface PodFileRef {
  /** The node that published it. */
  node: string;
  blob_id: string;
}

/** A node as the panel shows it; `busy_from` is the label of the origin it is busy for. */
export type PodPeer<T extends PeerView = PeerView> = T & { busy_from: string | null };

/** One permission request waiting for the human. */
export interface PodApproval {
  /** `node|task_id`: stable across polls. */
  id: string;
  /** The node the task runs on: what the panel posts back to approve or deny. */
  peer: string;
  task_id: string;
  tool: string;
  /** Short preview of the requested arguments. */
  requested: string;
  /** Label of the node that needs the permission. */
  from: string;
  /** The task's mode now, and the mode it asks to continue with until it ends. */
  current_mode: SandboxMode;
  requested_mode: SandboxMode;
  /** DSH session that dispatched the task; null for a send without one. */
  agent_id: string | null;
}

/** One row of the task tables: a task this node runs, or one it dispatched. */
export interface PodTaskRow {
  id: string;
  /** The node the task runs on, which details and cancel address: this node for local tasks, the target for dispatched ones. */
  peer: string;
  state: TaskState | "unknown";
  /** Origin of a local task, target of a dispatched one, as a display label. */
  who: string;
  who_title: string;
  at: string;
  /** The files its result names; a dispatched task's result is not kept here, so it names none. */
  files: PodFileRef[];
  cancellable: boolean;
}

/** Everything the task detail dialog shows. */
export interface PodTaskDetail {
  task: TaskView;
  origin: string;
  dispatch: DispatchEntry | null;
  files: PodFileRef[];
}

/** Where this node's workspace and its own state live. */
export interface WorkspaceView {
  root: string;
  state: string;
}

/** The pod's configuration as the panel sees it: the settings, and what the running node made of them. */
export interface PodConfigView {
  /** True once a workgroup and its stored password exist (first-run setup done). */
  configured: boolean;
  /**
   * The settings as the last start read them; an absent field takes its default.
   * They never hold the password, and the ACP executor's are left out: the env of
   * its MCP servers may hold secrets, and the panel does not edit them.
   */
  settings: Omit<Settings, "acp">;
  /** This node's orca node id (also the default display name), null before first start. */
  node_id: string | null;
  /** The name the node goes by: its own record's while it runs, else the setting. */
  display_name: string | null;
  /** The port the node listens on while it runs, else the setting. */
  port: number;
  /** Currently advertised dial URLs (the node's own list when it is running). */
  endpoints: string[];
  /** Dial URLs the form starts from: the usable advertised ones, else this machine's detected addresses. */
  suggested_endpoints: string[];
  /** The permission modes this DSH accepts, in rank order (read from DSH itself). */
  permission_modes: readonly SandboxMode[];
  /** The efforts the host's default model offers, least to most (read from DSH's `llm`). */
  reasoning_efforts: readonly LlmReasoningEffortInfo[];
  /** Listen addresses the form offers. */
  bind_choices: string[];
  /** Peers joined on startup: the configured ones and the ones remembered at runtime. */
  peers: string[];
  data_root: string;
  password_set: boolean;
  running: boolean;
  error: string | null;
}

/** Panel state snapshot: everything the status page and the approval cards render in one poll. */
export interface PodState {
  self: PodPeer<SelfRecord> | null;
  config: PodConfigView;
  /** Reachable members only: offline records are dropped. */
  members: PodPeer[];
  approvals: PodApproval[];
  recent: PodTaskRow[];
  workspace: WorkspaceView | null;
}

const Text = z.string().min(1, "must be a non-empty string");

/** `approve`, `cancel`: one task on one peer. */
export const PeerTaskBodySchema = z.object({ peer: Text, task_id: Text });
type PeerTaskBody = z.infer<typeof PeerTaskBodySchema>;

/** `deny`: the same, and why. A reason that is not text is dropped, not an error. */
export const DenyBodySchema = PeerTaskBodySchema.extend({ reason: z.string().optional().catch(undefined) });
type DenyBody = z.infer<typeof DenyBodySchema>;

/** `connect`: the peer address to join. */
export const ConnectBodySchema = z.object({ peer: Text });
type ConnectBody = z.infer<typeof ConnectBodySchema>;

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

/** `GET /orca-api/tasks`: every task this node knows about, for the "all tasks" view. */
type PodTasksResponse = { recent: PodTaskRow[] };

/** The GET routes: the query string each reads and the body it answers with. */
export type PodReads = {
  state: { query: Record<string, never>; response: PodState };
  tasks: { query: { limit?: number }; response: PodTasksResponse };
  task: { query: { peer: string; task: string }; response: PodTaskDetail };
};

/** What `approve`, `deny` and `cancel` answer with: the task as its peer reports it now. */
