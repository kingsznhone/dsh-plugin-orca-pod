import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { FileBlobRegistry, TaskStore } from "../storage/stores.ts";
import { errorMessage, PodError } from "../kernel/errors.ts";
import type { NodeLogger } from "../kernel/events.ts";
import type { LocalExecutor } from "../execution/executor.ts";
import { createGrantLedger } from "../security/grants.ts";
import {
  isTerminal,
  messageText,
  newTaskId,
  type A2AMessage,
  type TaskRunner,
  type TaskView,
} from "../protocol/task.ts";
import type { BusyState, OrcaNodeId, WorkgroupId } from "../protocol/peer.ts";
import { TaskRecord, type RecordHost } from "./record.ts";
import { parsePodMetadata } from "./meta.ts";
import { measureWorkspace, type WorkspacePaths, type WorkspaceUsage } from "./workspace.ts";

export type TaskRunnerDeps = {
  executor: LocalExecutor;
  /** Where the files a task produces are published (§5.6). */
  fileBlobs: FileBlobRegistry;
  /** Durable store (§5.5); every task change is written through it. */
  store: TaskStore;
  /** Group workspace: the executor's cwd (§6.7). */
  workspace: WorkspacePaths;
  logger: NodeLogger;
  selfOrcaNodeId: OrcaNodeId;
  workgroupId: WorkgroupId;
  /** Data root, so the prompt can point an agent at the local CLI (§6.14). */
  dataRoot: string;
  /** Local ceiling for inherited origin modes; an inherited mode can only narrow it (§7.10). */
  permissionMode?: SandboxMode;
  /** Auto-reject a parked permission request after this many seconds; unset waits forever (§7.12). */
  permissionTtlS?: number;
  /** Hard cap on task lifetime; peers see it as max_task_ttl_s (§6.9). Default 3600s. */
  taskTimeoutS?: number;
  /** Inline result summary cap in bytes; longer summaries are truncated (§6.11). Default 32 KiB. */
  resultMaxBytes?: number;
  /** A new task is refused while the workspace holds more than this (§6.13). */
  maxWorkspaceBytes: number;
  maxWorkspaceFiles: number;
  /** Called after every observable task change, for the UI event bus (§9.2). */
  onEvent: (view: TaskView) => void;
};

/**
 * The task runner: the single slot (§6.9), the store and lookups. One orca node
 * runs one task at a time, so a second task is refused with `orca_node_busy`;
 * everything about one task's life is in `record.ts`.
 */
export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const { store } = deps;
  const live = new Map<string, TaskRecord>();
  const taskTimeoutS = deps.taskTimeoutS ?? 3600;
  let slot: string | null = null;
  /**
   * What the workspace held when last measured: at startup, after every task
   * ends (only a running agent writes there) and after every refusal. Null until
   * the first walk finishes, so a task is only refused on a known overage (§6.13).
   */
  let usage: WorkspaceUsage | null = null;
  let walks = 0;

  function measure(): void {
    const walk = ++walks;
    measureWorkspace(deps.workspace.root).then(
      (measured) => {
        // A newer walk supersedes one that finished late.
        if (walk === walks) usage = measured;
      },
      (error: unknown) => deps.logger.warn(`workspace usage could not be measured: ${errorMessage(error)}`),
    );
  }

  const host: RecordHost = {
    ...deps,
    resultMaxBytes: deps.resultMaxBytes ?? 32 * 1024,
    ledger: createGrantLedger(),
    permissionMode: deps.permissionMode,
    permissionTtlS: deps.permissionTtlS,
    claim: (taskId) => {
      slot = taskId;
    },
    release: (taskId) => {
      if (slot === taskId) slot = null;
    },
    drop: (taskId) => {
      live.delete(taskId);
      measure();
    },
  };

  const busyError = (): PodError => new PodError("orca_node_busy", "orca node is busy with another task");

  function submit(input: Parameters<TaskRunner["submit"]>[0]): TaskView {
    if (slot !== null) throw busyError();
    const meta = parsePodMetadata(input.metadata);
    if (usage !== null && (usage.bytes > deps.maxWorkspaceBytes || usage.files > deps.maxWorkspaceFiles)) {
      // Measure again, so the next attempt sees it if the owner cleaned up meanwhile.
      measure();
      throw new PodError(
        "quota_exceeded",
        `the group workspace holds ${usage.files} files / ${usage.bytes} bytes, over its quota`,
      );
    }
    const id = newTaskId();
    const view: TaskView = {
      kind: "task",
      id,
      contextId: input.message.contextId ?? id,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      // Every reader learns who dispatched the task from the view (§7.6).
      metadata: { ...input.metadata, pod: { ...input.metadata?.pod, origin_orca_node: input.originOrcaNode } },
    };
    const record = new TaskRecord(host, {
      view,
      origin: input.originOrcaNode,
      meta,
      ttlS: Math.min(meta.taskTtlS ?? taskTimeoutS, taskTimeoutS),
      text: messageText(input.message),
    });
    slot = id;
    live.set(id, record);
    record.begin();
    return record.snapshot();
  }

  function get(taskId: string): TaskView | null {
    return live.get(taskId)?.snapshot() ?? store.load(taskId)?.view ?? null;
  }

  function originOf(taskId: string): OrcaNodeId | null {
    return live.get(taskId)?.origin ?? store.load(taskId)?.origin_orca_node ?? null;
  }

  /**
   * Local tasks for the UI task panel (§9.2): tasks still running first, then
   * the persisted store fills the remaining budget, newest update first.
   */
  function list(limit = 200): TaskView[] {
    const running = [...live.values()]
      .sort((left, right) => right.id.localeCompare(left.id))
      .map((record) => record.snapshot());
    if (running.length >= limit) return running.slice(0, limit);
    const stored = store
      .list()
      .filter((task) => !live.has(task.view.id))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((task) => task.view);
    return [...running, ...stored].slice(0, limit);
  }

  function resume(taskId: string, message: A2AMessage, callerOrcaNode?: string): TaskView {
    const record = live.get(taskId);
    if (record === undefined) {
      if (store.load(taskId) === undefined) throw new PodError("task_not_found", `unknown task ${taskId}`);
      throw new PodError("bad_request", "task is not input-required");
    }
    // Only the task's origin drives it; other workgroup members may read it (§5.3).
    if (callerOrcaNode !== undefined && callerOrcaNode !== record.origin) {
      throw new PodError("not_task_origin", `task ${taskId} belongs to another origin`);
    }
    if (record.state !== "input-required") throw new PodError("bad_request", "task is not input-required");
    // A parked task gave up the slot: while another task holds it, the origin retries later (§6.9).
    if (slot !== null) throw busyError();
    record.resume(message);
    return record.snapshot();
  }

  function cancel(taskId: string): TaskView {
    const record = live.get(taskId);
    if (record === undefined) {
      const stored = store.load(taskId);
      if (stored === undefined) throw new PodError("task_not_found", `unknown task ${taskId}`);
      return stored.view;
    }
    record.cancel();
    return record.snapshot();
  }

  function busy(): BusyState | null {
    const record = slot === null ? undefined : live.get(slot);
    return record === undefined
      ? null
      : { task_id: record.id, origin_orca_node: record.origin, since: record.createdAt };
  }

  /** §8.3: a restart never silently resumes work; every unfinished task fails. */
  function recover(): number {
    let count = 0;
    for (const stored of store.list()) {
      if (isTerminal(stored.view.status.state)) continue;
      const now = new Date().toISOString();
      const message: A2AMessage = {
        role: "agent",
        parts: [{ kind: "text", text: "task was interrupted by an orca node restart" }],
      };
      store.save({
        ...stored,
        view: { ...stored.view, status: { state: "failed", timestamp: now, message, reason: "node_restart" } },
        updated_at: now,
      });
      count += 1;
    }
    return count;
  }

  measure();
  return { submit, get, list, originOf, resume, cancel, busy, recover };
}
