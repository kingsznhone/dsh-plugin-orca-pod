/**
 * What the Orca panel and its host half say to each other over `/orca-api`
 * (§9.2), in one place: request bodies as schemas the host parses, response
 * shapes as types the client imports (type-only, so they are erased from the
 * bundle). `panel.ts` fills the shapes, `panel-routes.ts` serves them.
 */

import type { LlmReasoningEffortInfo, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { z } from "zod";

import type { PeerView, SelfRecord } from "../core/wire/peer.ts";
import type { ExecutorKind } from "../executor/kinds.ts";
import type { PanelPatch } from "../node/settings.ts";
import type { DispatchEntry, TaskState, TaskView } from "../task/wire.ts";

/** One artifact attached to a task: a file its node published (§5.6). */
export interface PodArtifact {
  name: string;
  blob_id: string;
  bytes: number;
  /** The node that published it; null when this node cannot tell which member runs the task. */
  node: string | null;
}

/** A node as the panel shows it; `busy_from` is the label of the origin it is busy for. */
export type PodPeer<T extends PeerView = PeerView> = T & { busy_from: string | null };

/** One permission request waiting for the human. */
export interface PodApproval {
  /** `node|task_id`: stable across polls. */
  id: string;
  /** What the panel posts back to approve or deny: the id of the node the task runs on. */
  peer: string;
  /** The node the task runs on. */
  node: string;
  task_id: string;
  tool: string;
  /** Short preview of the requested arguments. */
  requested: string;
  /** Label of the node that needs the permission. */
  from: string;
  /** The task's mode now, and the mode it asks to continue with until it ends. */
  current_mode: SandboxMode;
  requested_mode: SandboxMode;
  /** DSH session that dispatched the task. */
  agent_id: string;
}

/** One row of the task tables: a task this node runs, or one it dispatched. */
export interface PodTaskRow {
  id: string;
  /** What details and cancel address: this node's id for local tasks, the target's for dispatched ones (an old log entry keeps the address it recorded). */
  peer: string;
  /** The node the task runs on; null for an old log entry that only knew an address. */
  node: string | null;
  state: TaskState | "unknown";
  /** Origin of a local task, target of a dispatched one, as a display label. */
  who: string;
  who_title: string;
  at: string;
  artifacts: PodArtifact[];
  cancellable: boolean;
}

/** Everything the task detail dialog shows. */
export interface PodTaskDetail {
  task: TaskView;
  origin: string;
  dispatch: DispatchEntry | null;
  artifacts: PodArtifact[];
}

/** Workspace directories plus a shallow listing for the UI browser. */
export interface WorkspaceView {
  root: string;
  notes: string;
  state: string;
  /** Top-level files a later task will see in its appendix (`notes/<name>`). */
  notes_files: string[];
}

/** Advanced local controls the panel may edit; null means "not overridden". */
export interface PodAdvancedConfig {
  task_timeout_s: number | null;
  approval_timeout_s: number | null;
  result_max_bytes: number | null;
  max_workspace_bytes: number;
  max_workspace_files: number;
  allow_public_peers: boolean | null;
  allow_loopback_peers: boolean | null;
  permission_mode: SandboxMode | null;
  default_reasoning_effort: ReasoningEffortId | null;
  executor: ExecutorKind | null;
}

/** Effective pod configuration as the panel may see it (never the password). */
export interface PodConfigView {
  /** True once a workgroup and its stored password exist (first-run setup done). */
  configured: boolean;
  workgroup_id: string;
  /** This node's orca node id (also the default display name), null before first start. */
  node_id: string | null;
  display_name: string | null;
  /** Listen address the node actually uses. */
  bind_host: string;
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
  peers: string[];
  data_root: string;
  /** Local connection/timeout controls; null means the bundle default applies. */
  advanced: PodAdvancedConfig;
  password_set: boolean;
  running: boolean;
  error: string | null;
}

/** Panel state snapshot: everything the status page and the approval cards render in one poll. */
export interface PodState {
  self: PodPeer<SelfRecord> | null;
  config: PodConfigView;
  members: PodPeer[];
  mesh: { reachable: number };
  approvals: PodApproval[];
  approval_count: number;
  recent: PodTaskRow[];
  workspace: WorkspaceView | null;
}

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
